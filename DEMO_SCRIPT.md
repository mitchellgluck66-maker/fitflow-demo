# FitFlow Demo Script

## Overview
This document outlines the comprehensive demo script for FitFlow, the sales onboarding dashboard. Use this script to showcase the application to stakeholders.

**Duration**: 15-20 minutes

---

## Pre-Demo Setup

### 1. Start the Application
```bash
npm run dev
```
The app will run at `http://localhost:3000`

### 2. Verify Database
Ensure the database has been seeded with 23 sample leads:
```bash
npm run db:migrate
npm run db:seed
```

### 3. Clear Browser Cache (Optional)
For a clean demo experience, consider clearing browser cache and starting in private/incognito mode.

---

## Demo Flow

### Part 1: Welcome Screen (1 minute)
**Navigate to**: `http://localhost:3000`

**What to Show**:
- Clean, modern landing page
- Apple-inspired glass morphism design
- Quick navigation to key features

**Talking Points**:
- "FitFlow is built with a modern, professional design inspired by Apple's interface"
- "The glass morphism aesthetic creates visual depth and elegance"

---

### Part 2: Action Queue Dashboard (5 minutes)
**Navigate to**: `/dashboard`

**What to Show**:
1. **KPI Tiles** at the top
   - Total Leads: 23
   - Pipeline Value: ~$59k
   - Enrolled: 2
   - No-Show Rate: 35%

   **Talking Points**:
   - "At a glance, you can see the health of your pipeline"
   - "Real-time metrics update as leads move through stages"

2. **Stage Selector Buttons**
   - Click through different stages (Applied, Consult Booked, Consult No Show, etc.)
   - Show how the lead count changes per stage

   **Talking Points**:
   - "One-click filtering by stage makes it easy to focus on what matters"
   - "No complex spreadsheet navigation needed"

3. **Leads Table**
   - Expand each stage to see all leads
   - Point out key columns: Name, Email, Stage, Appointment, Value, Owner
   - Hover over badges to show color coding (success, warning, danger)

   **Talking Points**:
   - "All relevant lead information is visible at a glance"
   - "Green badges show success path, red shows issues"
   - "Quick action buttons (✓ and ✕) for marking attended/no-show"

4. **Quick Actions**
   - Click "✓" button on a lead in "Consult Booked" stage
   - Show success toast notification
   - Point out how the interface responds with feedback

   **Talking Points**:
   - "Instant feedback when actions complete"
   - "No waiting for page reloads"

---

### Part 3: Audit Log (3 minutes)
**Navigate to**: `/audit-log`

**What to Show**:
1. **Summary Stats**
   - Total Events count
   - Unique Actions count
   - This Month count

2. **Action Filtering**
   - Click on different action types to filter
   - Show events for MarkAttended, Enroll, etc.

3. **Event Details**
   - Each event shows:
     - Action type (color-coded badge)
     - Actor name
     - Prior → New stage transition
     - Timestamp
     - Sync status

   **Talking Points**:
   - "Complete audit trail for compliance and accountability"
   - "Every action is recorded with who did it and when"
   - "Easy to investigate what happened with any lead"
   - "Ready for audit requirements and reporting"

---

### Part 4: Weekly Reports (4 minutes)
**Navigate to**: `/reports`

**What to Show**:
1. **KPI Summary Section**
   - Total Leads, Pipeline Value, Enrolled, Conversion Rate
   - Show trend indicators

2. **Time Range Selector**
   - Toggle between Week/Month/All Time
   - Demonstrate how metrics update
   - Show how data filters in real-time

3. **Charts & Visualizations**
   - **Pipeline by Stage** (Bar Chart)
     - Shows distribution of leads across stages
   - **Pipeline Value by Stage** (Line Chart)
     - Displays financial value progression
   - **Leads by Source** (Pie Chart)
     - Breakdown of lead sources (Facebook, Google, Referral, etc.)
   - **Revenue by Source** (Progress Bars)
     - Financial contribution by each source

   **Talking Points**:
   - "Visual analytics make it easy to spot trends"
   - "See which sources generate the most qualified leads"
   - "Understand your sales pipeline at a glance"

4. **Pipeline Summary Table**
   - Detailed breakdown with lead counts and percentages
   - Show total row for reference

5. **Export Button**
   - Click "Export" to download CSV report
   - Show that file downloads automatically
   - Mention ability to share with team/leadership

   **Talking Points**:
   - "Reports are exportable for leadership presentations"
   - "One-click CSV export for easy sharing"

---

### Part 5: Settings & Configuration (2 minutes)
**Navigate to**: `/settings`

**What to Show**:
1. **General Settings**
   - Application Name field
   - Theme selector (Light/Dark/Auto)

2. **Timezone Configuration**
   - Dropdown with 14 timezones
   - Click a different timezone to see time update
   - Show current time in selected timezone

   **Talking Points**:
   - "Set your timezone once, all times display correctly"
   - "Perfect for distributed teams across multiple regions"

3. **Sync Settings**
   - Auto Sync toggle
   - Sync interval slider (1-60 minutes)

   **Talking Points**:
   - "Automatic background syncing keeps data fresh"
   - "Configurable sync frequency to match your needs"

4. **Notifications**
   - Toggle notifications on/off

5. **Save & Reset Buttons**
   - Make a change and show "Save Settings" button enables
   - Show success toast after saving

   **Talking Points**:
   - "Settings persist across sessions"
   - "Easy to reconfigure anytime"

---

### Part 6: Data Flow & Integration (2 minutes)

**Talking Points**:
- "FitFlow uses a simple 3-step data model:"
  1. **Leads** - Complete contact and pipeline information
  2. **Lead Events** - Immutable audit trail of all actions
  3. **Settings** - User preferences and configuration

- "Attribution tracking is preserved throughout:"
  - Original source never changes
  - UTM parameters captured
  - Outcomes tracked for each stage

- "Future integration ready:"
  - Manual entry for MVP
  - GoHighLevel API integration ready for Phase 2
  - Webhook support for real-time updates

---

## Key Features to Emphasize

### ✅ What's Working Now
- ✓ Complete action queue dashboard with real-time filtering
- ✓ 23 pre-seeded sample leads across all 8 pipeline stages
- ✓ Glass morphism UI with Apple-inspired design
- ✓ Comprehensive audit logging for compliance
- ✓ Weekly reports with multiple chart types
- ✓ Timezone-aware time display
- ✓ Smooth animations and transitions
- ✓ Error handling and user feedback
- ✓ Responsive design (works on desktop)

### 🚀 Phase 2 (Future Enhancements)
- GoHighLevel API integration (requires tokens)
- Two-way data sync
- Webhook support
- Mobile app
- Custom field mapping
- Advanced filtering and search
- Bulk actions
- Email templates
- Calendar integration

---

## Demo Data

### Sample Leads by Stage
| Stage | Count | Description |
|-------|-------|-------------|
| Applied | 2 | Just signed up, waiting for consult |
| Consult Booked | 3 | Appointment scheduled |
| Consult No Show | 8 | Missed their appointment |
| Pre-Roadmap Booked | 2 | Scheduled for roadmap review |
| Roadmap No Show | 3 | Missed roadmap appointment |
| Roadmap Completed: Objection | 2 | Completed but had concerns |
| Enrolled | 2 | Successfully enrolled |
| Previous Leads | 1 | Archived/past leads |

**Total Pipeline Value**: ~$59,700 (estimated at 30% conversion)

---

## Common Questions During Demo

**Q: Will this replace GoHighLevel?**
A: FitFlow focuses on the onboarding pipeline specifically. It simplifies data entry and eliminates the need to log into GoHighLevel just for tracking leads. Phase 2 will include full GHL integration.

**Q: How is lead data stored?**
A: In a local SQLite database. Future phases will use Cloudflare D1 (managed SQLite) for cloud deployment.

**Q: Can I bulk import leads?**
A: Currently, leads are entered manually or imported from the sample seed. Phase 2 will support CSV import and GHL API sync.

**Q: How is this deployed?**
A: Currently running locally. Phase 2 will deploy to Cloudflare Pages with D1 database.

**Q: Is timezone really per-user?**
A: Yes! Each user can set their own timezone in settings. Currently demo is single-user, but the structure supports multi-user in Phase 2.

---

## Demo Troubleshooting

### If database is empty:
```bash
npm run db:seed
```

### If styles look broken:
- Clear browser cache (Cmd+Shift+R or Ctrl+Shift+R)
- Restart dev server: Stop with Ctrl+C, then `npm run dev`

### If animations are choppy:
- This is normal on dev server
- Production builds with Next.js optimization will be much smoother

### If a page doesn't load:
- Check browser console for errors (F12 > Console tab)
- Verify database migrations ran successfully
- Restart dev server

---

## Post-Demo Next Steps

1. **Schedule Follow-up** - "I'd like to show this to [key stakeholder]"
2. **Gather Feedback** - "What features matter most for your team?"
3. **Plan Phase 2** - "Here's what we'll build next..."
4. **Set Timeline** - "We can have GHL integration in X weeks"

---

## Quick Reference URLs

- **Dashboard**: http://localhost:3000/dashboard
- **Audit Log**: http://localhost:3000/audit-log
- **Reports**: http://localhost:3000/reports
- **Settings**: http://localhost:3000/settings
- **API - Leads**: http://localhost:3000/api/leads
- **API - Events**: http://localhost:3000/api/events
- **API - Settings**: http://localhost:3000/api/settings

---

**Last Updated**: August 19, 2026
**Demo Duration**: 15-20 minutes
**Difficulty Level**: Beginner-friendly
