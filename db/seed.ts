import { db, leads, leadEvents } from './index';
import { sql } from 'drizzle-orm';

const FIRST_NAMES = ['Vanitha', 'August', 'June', 'James', 'Sarah', 'Alex', 'Jordan', 'Casey', 'Morgan', 'Taylor', 'Riley', 'Chris', 'Jamie', 'Kelly', 'Drew', 'Quinn', 'Blake', 'Avery', 'Dakota', 'Phoenix'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'White'];
const SOURCES = ['Facebook', 'Instagram', 'Google', 'Referral', 'Website', 'LinkedIn', 'TikTok', 'Email'];
const OWNERS = ['Miranda', 'Jake', 'Sarah', 'Team Lead'];
const STAGES = ['Applied', 'Consult Booked', 'Consult No Show', 'Pre-Roadmap Booked', 'Roadmap No Show', 'Roadmap Completed: Objection', 'Enrolled', 'Previous Leads'];

function getRandomItem<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

function generateEmail(firstName: string, lastName: string): string {
  return `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`;
}

function generatePhone(): string {
  return `+1${Math.floor(Math.random() * 9000000000 + 1000000000)}`;
}

function getRandomDate(daysBack: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - Math.floor(Math.random() * daysBack));
  return date;
}

async function seedDatabase() {
  console.log('🌱 Seeding FitFlow database...');

  try {
    // Clear existing data
    await db.delete(leadEvents).run();
    await db.delete(leads).run();
    console.log('✓ Cleared existing data');

    // Create realistic distribution of leads across stages
    const leadDefs = [
      { count: 2, stage: 'Applied' },
      { count: 3, stage: 'Consult Booked' },
      { count: 8, stage: 'Consult No Show' },
      { count: 2, stage: 'Pre-Roadmap Booked' },
      { count: 3, stage: 'Roadmap No Show' },
      { count: 2, stage: 'Roadmap Completed: Objection' },
      { count: 2, stage: 'Enrolled' },
      { count: 1, stage: 'Previous Leads' },
    ];

    let leadsCreated = 0;

    for (const def of leadDefs) {
      for (let i = 0; i < def.count; i++) {
        const firstName = getRandomItem(FIRST_NAMES);
        const lastName = getRandomItem(LAST_NAMES);
        const source = getRandomItem(SOURCES);
        const stage = def.stage;
        const owner = getRandomItem(OWNERS);

        const createdDate = getRandomDate(60); // Last 60 days
        const appointmentDate = new Date(createdDate);
        appointmentDate.setDate(appointmentDate.getDate() + (7 + Math.floor(Math.random() * 14))); // 7-21 days after creation

        const leadId = `lead_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Insert lead
        await db.insert(leads).values({
          id: leadId,
          firstName,
          lastName,
          email: generateEmail(firstName, lastName),
          phone: generatePhone(),
          pipelineId: '[new] Application Pipeline',
          pipelineName: '[new] Application Pipeline',
          stage,
          status: stage === 'Previous Leads' ? 'archived' : 'active',
          source,
          originalSource: source,
          utmSource: source === 'Referral' ? 'organic' : source.toLowerCase(),
          utmCampaign: `Campaign_${Math.floor(Math.random() * 1000)}`,
          utmMedium: source === 'Referral' ? 'referral' : 'social',
          entryFunnel: 'Application 7.10',
          ghlSource: 'Application 1',
          appointmentTime: appointmentDate.toISOString(),
          appointmentStatus: stage === 'Applied' ? 'scheduled' : stage.includes('No Show') ? 'no_show' : stage === 'Enrolled' ? 'attended' : 'scheduled',
          estimatedValue: Math.random() > 0.7 ? 29900 : 0, // 30% have a value
          owner,
          tags: JSON.stringify([`${stage.toLowerCase().replace(/\s+/g, '_')}`, 'new_lead', source.toLowerCase()]),
          notes: `Lead from ${source}. Interested in coaching program.`,
          createdAt: createdDate.toISOString(),
          updatedAt: new Date().toISOString(),
          dateApplied: createdDate.toISOString(),
          lastActionAt: stage === 'Consulted' || stage === 'Consult No Show' ? appointmentDate.toISOString() : undefined,
        });

        leadsCreated++;

        // Create a sample event for first action
        if (stage !== 'Applied') {
          const eventDate = new Date(createdDate);
          eventDate.setDate(eventDate.getDate() + 7);

          let action = 'MarkAttended';
          if (stage === 'Consult No Show') action = 'MarkNoShow';
          if (stage === 'Enrolled') action = 'Enroll';

          await db.insert(leadEvents).values({
            id: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            leadId,
            action,
            priorStage: stage === 'Applied' ? 'Applied' : 'Consult Booked',
            newStage: stage,
            appointmentStatus: action === 'MarkNoShow' ? 'no_show' : 'attended',
            actor: owner,
            notes: `${action} recorded for ${firstName} ${lastName}`,
            syncStatus: 'local',
            createdAt: eventDate.toISOString(),
          });
        }
      }
    }

    console.log(`✓ Created ${leadsCreated} sample leads with realistic distribution`);
    console.log('✓ Database seeded successfully!');
    process.exit(0);
  } catch (error) {
    console.error('✗ Seeding failed:', error);
    process.exit(1);
  }
}

seedDatabase();
