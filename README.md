# FitFlow - Sales Onboarding Dashboard

A professional, production-quality sales pipeline management dashboard built with Next.js, TypeScript, and modern design principles.

## 🎯 Overview

FitFlow simplifies the sales onboarding process by providing a streamlined interface for tracking leads through your application pipeline. Built with an Apple-inspired glass morphism aesthetic and packed with powerful analytics, FitFlow reduces GoHighLevel interaction while maintaining complete attribution tracking and compliance audit trails.

**Status**: MVP Complete (8/19/2026)
**Next Phase**: GoHighLevel API Integration

## ✨ Key Features

- **Action Queue Dashboard** - Real-time lead management with instant filtering by stage
- **8-Stage Pipeline** - Applied → Consult Booked → Enrolled tracking
- **Comprehensive Audit Log** - Immutable event trail for compliance
- **Weekly Reports** - Analytics with bar, line, and pie charts
- **Timezone Settings** - 14 timezones with real-time preview
- **Glass Morphism UI** - Apple-inspired design with smooth animations
- **Error Handling** - Error boundaries with user-friendly recovery
- **CSV Export** - Download reports for team sharing

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Set up database
npm run db:migrate
npm run db:seed

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the dashboard.

## 📋 Available Routes

- `/dashboard` - Main action queue and lead management
- `/reports` - Analytics and weekly reporting
- `/audit-log` - Compliance audit trail
- `/settings` - Timezone and app configuration

## 🛠️ Tech Stack

- **Framework**: Next.js 14 with App Router
- **Language**: TypeScript
- **Styling**: Tailwind CSS 4
- **Animations**: Framer Motion
- **Charts**: Recharts
- **Database**: SQLite with Drizzle ORM
- **UI Components**: Custom glass morphism components

## 📊 Sample Data

The database comes with **23 realistic leads** across all pipeline stages:
- Applied (2)
- Consult Booked (3)
- Consult No Show (8)
- Pre-Roadmap Booked (2)
- Roadmap No Show (3)
- Roadmap Completed: Objection (2)
- Enrolled (2)
- Previous Leads (1)

**Estimated Pipeline Value**: $59,700

## 📚 Documentation

- **[DEMO_SCRIPT.md](./DEMO_SCRIPT.md)** - 15-20 minute demo walkthrough
- **[GHL_RESEARCH_AND_STRUCTURE.md](./GHL_RESEARCH_AND_STRUCTURE.md)** - GoHighLevel integration details

## 🔮 Phase 2 Roadmap

- GoHighLevel API integration
- Bidirectional lead sync
- Multi-user support with roles
- Mobile app
- Advanced filtering and search
- Custom pipeline configuration

---

**Last Updated**: August 19, 2026  
**Version**: 0.1.0  
**Status**: Production-Ready MVP
