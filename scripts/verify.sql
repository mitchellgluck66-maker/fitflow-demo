-- Independent recompute (raw SQL, never lib/metrics) for one range {S}..{E}, both currencies.
-- Used by scripts/verify.ts (compare step); {TZ} = business timezone, {ASOF} = the run's instant (ISO).
-- Wave 2 definitions (2026-09-30):
--   applied  = the followed-pipeline opportunity's createdAt (ghl_opportunities), else contacts.opportunity_created_at;
--              an opportunity first seen in another pipeline is dated by its entry into the followed one (F14);
--   roles    = resolved through the transition's stage NOW, the stored role only when the stage is gone (F4);
--   show rate = showed ÷ (showed + no-show), shown only when ≥ 90% of past appointments have an outcome (F2).
with params as (select '{S}'::date s, '{E}'::date e, '{ASOF}'::timestamptz asof),
ccys as (select unnest(array['CAD','USD']) rep),
fx as (select date, rate from fx_rates where from_ccy='USD' and to_ccy='CAD' and rate>0),
tp as (select id from pipelines where is_tracked and archived_at is null),
moved as (
  select x.opp, min(t2.observed_at) entered from (
    select t.ghl_opportunity_id opp, min(t.observed_at) first_else from stage_transitions t
    where t.ghl_opportunity_id is not null and t.pipeline_id is not null and t.pipeline_id not in (select id from tp) group by 1) x
  join stage_transitions t2 on t2.ghl_opportunity_id=x.opp and t2.pipeline_id in (select id from tp) and t2.observed_at > x.first_else
  group by x.opp),
c as (select c.*, s.semantic_role role,
        (case when c.origin='demo' then (coalesce(c.ghl_created_at,c.created_at) at time zone '{TZ}')::date
              else (coalesce(mv.entered, o.ghl_created_at, c.opportunity_created_at) at time zone '{TZ}')::date end) applied_on
      from contacts c left join stages s on s.id=c.stage_id
        left join ghl_opportunities o on o.id=c.ghl_opportunity_id
        left join moved mv on mv.opp=c.ghl_opportunity_id
      where c.pipeline_id in (select id from tp) or c.pipeline_id is null),
tr as (select t.contact_id, (case when ts.id is not null then ts.semantic_role else t.to_role end) to_role, t.observed_at, (t.observed_at at time zone '{TZ}')::date d
       from stage_transitions t join c on c.id=t.contact_id left join stages ts on ts.id=t.to_stage_id),
firstt as (select distinct on (contact_id) contact_id, to_role from tr order by contact_id, observed_at),
parked as (select c.id from c left join firstt f on f.contact_id=c.id where (f.contact_id is not null and f.to_role='previous_lead') or (f.contact_id is null and c.role='previous_lead')),
ap as (select a.contact_id, a.type, a.outcome, a.start_time, (a.start_time at time zone '{TZ}')::date d from appointments a),
m_applied as (select id cid from c,params where applied_on between s and e and id not in (select id from parked)),
m_entered as (select distinct to_role, contact_id cid from tr,params where d between s and e and contact_id not in (select id from parked)),
m_showed as (select distinct type, contact_id cid from ap,params where contact_id is not null and outcome='showed' and d between s and e and contact_id not in (select id from parked)),
per as (
 select 'applied' k, cid from m_applied
 union select 'consult_booked', cid from m_entered where to_role='consult_booked'
 union select 'consult_showed', cid from m_showed where type='Consult'
 union select 'roadmap_booked', cid from m_entered where to_role='roadmap_booked'
 union select 'roadmap_showed', cid from m_showed where type='Roadmap'
 union select 'roadmap_showed', cid from m_entered where to_role='roadmap_showed'
 union select 'enrolled', cid from m_entered where to_role='enrolled'),
prev_period as (select distinct contact_id cid from tr,params where to_role='previous_lead' and d between s and e),
coh as (select cid from m_applied),
cohm as (
 select 'applied' k, cid from coh
 union select 'consult_booked', t.contact_id from tr t join coh on coh.cid=t.contact_id where to_role='consult_booked'
 union select 'consult_showed', a.contact_id from ap a join coh on coh.cid=a.contact_id where type='Consult' and outcome='showed'
 union select 'roadmap_booked', t.contact_id from tr t join coh on coh.cid=t.contact_id where to_role='roadmap_booked'
 union select 'roadmap_showed', a.contact_id from ap a join coh on coh.cid=a.contact_id where type='Roadmap' and outcome='showed'
 union select 'roadmap_showed', t.contact_id from tr t join coh on coh.cid=t.contact_id where to_role='roadmap_showed'
 union select 'enrolled', t.contact_id from tr t join coh on coh.cid=t.contact_id where to_role='enrolled'),
prev_cohort as (select distinct t.contact_id cid from tr t join coh on coh.cid=t.contact_id where to_role='previous_lead'),
r as (select d::date d, coalesce((select rate from fx where fx.date<=d::date order by fx.date desc limit 1),(select rate from fx order by date limit 1)) rate
      from generate_series('2025-01-01'::date,'2027-12-31'::date,'1 day') d),
rlatest as (select coalesce((select rate from fx order by date desc limit 1),1) rate),
sp as (select a.date d, a.spend_cents, a.currency, a.campaign_id, a.campaign_name, a.platform from ad_spend a, params where a.date between s and e and a.origin not in ('manual') ),
sp_c as (select ccys.rep, sp.*, case when sp.currency=ccys.rep then sp.spend_cents
          when sp.currency='USD' then floor(sp.spend_cents*r.rate+0.5)
          else floor(sp.spend_cents*(1.0::float8/r.rate)+0.5) end::bigint cents
         from sp cross join ccys join r on r.d=sp.d),
spend as (select rep, sum(cents) cents, count(*) nrows, count(distinct coalesce(campaign_id,campaign_name)) ncamp from sp_c group by rep),
pay as (select p.*, coalesce((p.paid_at at time zone '{TZ}')::date,(p.failed_at at time zone '{TZ}')::date) d from payments p),
pay_c as (select ccys.rep, pay.*,
   case when pay.currency=ccys.rep then pay.amount_cents when pay.currency='USD' then floor(pay.amount_cents*coalesce(r.rate,(select rate from rlatest))+0.5) else floor(pay.amount_cents*(1.0::float8/coalesce(r.rate,(select rate from rlatest)))+0.5) end::bigint amt,
   case when pay.currency=ccys.rep then pay.refunded_cents when pay.currency='USD' then floor(pay.refunded_cents*coalesce(r.rate,(select rate from rlatest))+0.5) else floor(pay.refunded_cents*(1.0::float8/coalesce(r.rate,(select rate from rlatest)))+0.5) end::bigint ref
   from pay cross join ccys left join r on r.d=pay.d),
pin as (select pay_c.* , greatest(0, amt-ref) * (case when kind not in ('refund','subscription') and status in ('succeeded','refunded') then 1 else 0 end) net,
        (kind<>'refund' and status in ('succeeded','refunded')) is_cash
        from pay_c, params where kind<>'subscription' and d between s and e),
rev as (select rep,
   sum(net) filter (where is_cash and payment_class='initial') initial_c, count(*) filter (where is_cash and payment_class='initial') initial_n,
   sum(net) filter (where is_cash and payment_class='recurring') recurring_c, count(*) filter (where is_cash and payment_class='recurring') recurring_n,
   sum(net) filter (where is_cash and payment_class is null and net>0) unclass_c, count(*) filter (where is_cash and payment_class is null and net>0) unclass_n,
   sum(ref) filter (where is_cash) refunded_c,
   sum(amt) filter (where is_cash) gross_c,
   count(*) filter (where is_cash and status='succeeded') paid_n,
   count(*) filter (where status='failed') failed_n, sum(amt) filter (where status='failed') failed_c,
   count(*) filter (where ref>0) refund_rows,
   count(*) filter (where contact_id is null and status='succeeded') unmatched_n,
   count(*) filter (where payment_class='excluded') excl_n,
   count(*) filter (where payment_class='excluded' and kind='refund') ex_refund,
   count(*) filter (where payment_class='excluded' and kind<>'refund' and status='failed') ex_failed,
   count(*) filter (where payment_class='excluded' and kind<>'refund' and status<>'failed' and (status='refunded' or (amount_cents>0 and refunded_cents>=amount_cents))) ex_fully_refunded,
   count(*) filter (where payment_class='excluded' and kind<>'refund' and status<>'failed' and not (status='refunded' or (amount_cents>0 and refunded_cents>=amount_cents))) ex_pending,
   count(*) listed
   from pin group by rep),
pattr as (select pin.rep, coalesce(c.attribution_class,'none') att, sum(net) cents, count(*) n from pin left join c on c.id=pin.contact_id where payment_class='initial' and net>0 group by 1,2),
mrr as (select rep, sum(amt) cents, count(*) n from pay_c where kind='subscription' and status in ('active','trialing','past_due') group by rep),
enr as (select per.cid, c.attribution_class att, c.monetary_value_cents mv, c.applied_on from per join c on c.id=per.cid where k='enrolled'),
enr_c as (select ccys.rep, enr.*, case when enr.mv>0 then (case when ccys.rep='CAD' then enr.mv else floor(enr.mv*(1.0::float8/coalesce(r.rate,(select rate from rlatest)))+0.5) end) end::bigint mvc from enr cross join ccys left join r on r.d=enr.applied_on),
cv as (select rep, sum(mvc) cents, count(*) filter (where mvc is null) missing from enr_c group by rep),
shows as (select type, count(*) past, count(*) filter (where outcome='showed') showed, count(*) filter (where outcome='no_show') no_show, count(*) filter (where outcome='cancelled') cancelled
          from ap, params where d between s and e and start_time <= asof group by type),
counts as (select k, count(distinct cid) n from per group by k),
ccounts as (select k, count(distinct cid) n from cohm group by k)
select json_build_object(
 'range', (select s||'..'||e from params),
 'period', (select json_object_agg(k,n) from counts),
 'period_previous_leads', (select count(*) from prev_period),
 'cohort', (select json_object_agg(k,n) from ccounts),
 'cohort_previous_leads', (select count(*) from prev_cohort),
 'parked_total', (select count(*) from parked),
 'applicants_without_date', (select count(*) from c where applied_on is null),
 'has_stripe', (select exists(select 1 from payments where origin='stripe')),
 'enrolled_by_att', (select json_object_agg(coalesce(att,'none'),n) from (select att,count(*) n from enr group by att) x),
 'show_rates', (select json_agg(shows order by type) from shows),
 'by_ccy', (select json_object_agg(rep, row_to_json(z)) from (
    select ccys.rep, sp.cents spend, sp.nrows spend_rows, sp.ncamp campaigns,
      rev.initial_c, rev.initial_n, rev.recurring_c, rev.recurring_n, rev.unclass_c, rev.unclass_n,
      coalesce(rev.initial_c,0)+coalesce(rev.recurring_c,0)+coalesce(rev.unclass_c,0) collected,
      rev.refunded_c, rev.gross_c, rev.paid_n, rev.failed_n, rev.failed_c, rev.refund_rows, rev.unmatched_n, rev.listed,
      rev.excl_n, rev.ex_refund, rev.ex_failed, rev.ex_fully_refunded, rev.ex_pending,
      (select json_object_agg(att, json_build_object('cents',cents,'n',n)) from pattr where pattr.rep=ccys.rep) initial_by_att,
      cv.cents contract_value, cv.missing contract_missing,
      mrr.cents mrr, mrr.n active_subs
    from ccys left join spend sp on sp.rep=ccys.rep left join rev on rev.rep=ccys.rep left join cv on cv.rep=ccys.rep left join mrr on mrr.rep=ccys.rep) z)
) out
