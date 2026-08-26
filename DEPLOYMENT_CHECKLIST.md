# FitFlow Deployment Checklist

Use this checklist to ensure everything is ready for production deployment to Cloudflare Pages.

## Pre-Deployment Verification (1 hour before)

### Code Quality
- [ ] Run `npm run lint` - No linting errors
- [ ] Run `npm run build` - Build succeeds
- [ ] All dependencies up to date: `npm audit`
- [ ] No console errors in dev server
- [ ] All routes tested locally

### Database
- [ ] Database migrations applied: `npm run db:migrate`
- [ ] Database seeded with sample data: `npm run db:seed`
- [ ] Database file exists at `./db/fitflow.db`
- [ ] No database errors in console

### Features
- [ ] Dashboard loads and displays all KPI tiles
- [ ] Lead filtering works on all stages
- [ ] Quick action buttons (✓ ✕) respond
- [ ] Reports page generates charts
- [ ] Audit log displays events
- [ ] Settings page saves preferences
- [ ] Timezone selector works
- [ ] Export CSV button functions

### Browser Testing
- [ ] Chrome/Edge: No errors or warnings
- [ ] Firefox: All features work
- [ ] Safari: Layout looks correct
- [ ] Mobile viewport: Responsive layout
- [ ] Dark mode works (if enabled)

### Performance
- [ ] No console warnings
- [ ] Network tab shows reasonable load times
- [ ] No memory leaks (check DevTools)
- [ ] Animations are smooth (60 FPS)

### Git & Version Control
- [ ] All changes committed: `git status` clean
- [ ] Commit messages are descriptive
- [ ] Branch is up to date with main
- [ ] No merge conflicts

## Cloudflare Preparation (30 minutes before)

### Account Setup
- [ ] Cloudflare account created and verified
- [ ] Domain registered or transferred to Cloudflare
- [ ] Nameservers pointing to Cloudflare
- [ ] SSL/TLS enabled (Full or Full Strict)

### Infrastructure Setup
- [ ] D1 database created in Cloudflare
- [ ] Database ID updated in `wrangler.toml`
- [ ] Pages project created and connected
- [ ] GitHub/GitLab repository connected
- [ ] Build settings configured:
  - Framework: Next.js
  - Build command: `npm run build`
  - Build output: `.next`

### Environment Configuration
- [ ] Production environment variables set:
  - TIMEZONE (production timezone)
  - APP_NAME (production name)
  - ENVIRONMENT=production
- [ ] Database binding configured
- [ ] Secrets encrypted if any

## Deployment Process

### Pre-Flight (Do NOT proceed if anything is incomplete)
- [ ] All checklist items above are checked
- [ ] Team notified of deployment
- [ ] Deployment window scheduled
- [ ] Rollback plan documented

### Actual Deployment
- [ ] Push final code: `git push origin main`
- [ ] Verify Cloudflare Pages starts building
- [ ] Check build logs for errors
- [ ] Wait for build to complete
- [ ] Verify preview URL loads

### Database Migration (if applicable)
- [ ] Connect to production database
- [ ] Run migrations: `wrangler d1 execute fitflow --remote < migrations/0001_init.sql`
- [ ] Verify schema created
- [ ] Optionally seed data if needed

## Post-Deployment Verification (30 minutes after)

### Smoke Tests
- [ ] Production URL loads (https://your-domain.pages.dev)
- [ ] Landing page displays correctly
- [ ] Dashboard route works: `/dashboard`
- [ ] Reports route works: `/reports`
- [ ] Audit log route works: `/audit-log`
- [ ] Settings route works: `/settings`

### Functionality Tests
- [ ] Can filter leads by stage
- [ ] Quick actions work (✓ ✕ buttons)
- [ ] Charts render properly
- [ ] CSV export downloads
- [ ] Timezone selector works
- [ ] Toast notifications appear
- [ ] API calls complete successfully

### Performance Tests
- [ ] Page loads in < 3 seconds
- [ ] No 404 errors in console
- [ ] No CORS errors
- [ ] API responses < 1 second
- [ ] Database queries working

### Monitoring Setup
- [ ] Cloudflare analytics enabled
- [ ] Error logging configured
- [ ] Uptime monitoring enabled
- [ ] Alerts configured for errors/downtime

### Email Notifications
- [ ] Team notified of successful deployment
- [ ] Documentation link shared
- [ ] Demo script link shared
- [ ] Next steps communicated

## Rollback Plan (If Issues Occur)

### Emergency Rollback
1. [ ] Identify issue in Cloudflare Dashboard
2. [ ] Check recent commits for cause
3. [ ] Rollback to previous commit:
   ```bash
   git revert <commit-hash>
   git push origin main
   ```
4. [ ] Verify previous version loads
5. [ ] Investigate issue locally
6. [ ] Fix and redeploy

### Data Recovery
- [ ] Database backups verified
- [ ] Export command tested: `wrangler d1 export fitflow --output backup.sql --remote`
- [ ] Backup stored securely

## Post-Deployment Monitoring (Next 24 hours)

### First Hour
- [ ] Check Cloudflare analytics every 15 minutes
- [ ] Monitor error logs for issues
- [ ] Be ready for quick rollback

### First Day
- [ ] No unusual error spikes
- [ ] All features working as expected
- [ ] Performance stable
- [ ] Team reports no issues

### Ongoing
- [ ] Set up weekly performance review
- [ ] Monitor D1 database usage
- [ ] Review cost estimates
- [ ] Plan Phase 2 features

## Feature Flags & Configuration

### Before Production Launch
- [ ] ENVIRONMENT variable set to "production"
- [ ] Debug mode disabled
- [ ] Console logging disabled (in production)
- [ ] API rate limiting configured
- [ ] CORS properly configured

### After Production Launch
- [ ] Monitor error rates
- [ ] Check database performance
- [ ] Review user feedback
- [ ] Plan optimizations

## Documentation & Runbooks

### Create/Update:
- [ ] Production runbook
- [ ] Troubleshooting guide
- [ ] Rollback procedure
- [ ] Escalation contacts
- [ ] On-call schedule

### Share:
- [ ] Deployment guide
- [ ] API documentation
- [ ] Settings documentation
- [ ] Demo script

## Team Communication

### Before Deployment
- [ ] Send deployment notification email
- [ ] Post in team Slack/Teams
- [ ] Schedule announcement
- [ ] Brief on features

### During Deployment
- [ ] Real-time status updates
- [ ] Link to deployment dashboard
- [ ] Ask team to stand by

### After Deployment
- [ ] Celebrate successful launch!
- [ ] Send success notification
- [ ] Share metrics/results
- [ ] Gather feedback

## Success Criteria

✅ Deployment is successful when:
- [ ] All routes accessible from production URL
- [ ] No error logs (or only expected errors)
- [ ] Page load time < 3 seconds
- [ ] Database queries working
- [ ] API endpoints responding
- [ ] Charts rendering correctly
- [ ] Reports exporting as CSV
- [ ] Audit log displaying events
- [ ] Settings saving preferences
- [ ] No alerts or warnings

## Post-Launch Retrospective

### Timing
- Schedule within 1 week of launch
- Include deployment team
- Include stakeholders

### Discussion Topics
- What went well?
- What could improve?
- Any unexpected issues?
- Performance observations
- Customer feedback

### Action Items
- Document improvements
- Plan Phase 2 features
- Schedule next deployment

---

## Deployment Contacts

- **Deploy Lead**: [Name] ([Email])
- **On-Call**: [Name] ([Phone])
- **Cloudflare Support**: support@cloudflare.com
- **Escalation**: [Manager] ([Email])

## Important Links

- **Cloudflare Dashboard**: https://dash.cloudflare.com
- **Pages Deployments**: https://dash.cloudflare.com/pages
- **D1 Database**: https://dash.cloudflare.com/d1
- **Repository**: [GitHub URL]
- **Production URL**: [Your domain]

---

**Deployment Date**: _______________
**Deployed By**: _______________
**Approved By**: _______________
**Time Completed**: _______________

**Status**: ☐ Success  ☐ Rollback  ☐ Partial

**Notes**: _______________________________________________

---

Last Updated: August 19, 2026
