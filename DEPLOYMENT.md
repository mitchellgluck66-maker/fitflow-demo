# FitFlow Deployment Guide

This guide covers deploying FitFlow to Cloudflare Pages with D1 database.

## Prerequisites

- Cloudflare account (free tier works)
- Node.js 18+
- Wrangler CLI (`npm i -g wrangler@latest`)
- Git repository

## Deployment Steps

### 1. Prepare Your Project

```bash
# Ensure all code is committed
git status
git add .
git commit -m "Final commit before deployment"

# Build production bundle
npm run build

# Verify build succeeded
ls -la .next/
```

### 2. Set Up Cloudflare

#### a. Create Cloudflare Account
- Visit https://dash.cloudflare.com
- Sign up or log in
- Add your domain (or use free Cloudflare Pages domain)

#### b. Create D1 Database

```bash
# Create the database
wrangler d1 create fitflow

# Note the database_id and update wrangler.toml
```

After running this command, update `wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "fitflow"
database_id = "your-database-id-here"  # <-- Update this
```

#### c. Create Pages Project

Option 1: Deploy from Git (Recommended)
```bash
# Push to GitHub
git push origin main

# Visit https://dash.cloudflare.com
# Go to Pages > Create > Connect Git
# Select your repository
# Configure build settings:
#   - Framework: Next.js
#   - Build command: npm run build
#   - Build output directory: .next
```

Option 2: Deploy from CLI
```bash
# Install Wrangler if not already installed
npm install -g wrangler

# Log in to Cloudflare
wrangler login

# Deploy
wrangler deploy
```

### 3. Configure Environment

In Cloudflare Pages Settings:
1. Go to Settings > Environment Variables
2. Add the following for Production:
```
TIMEZONE=America/New_York
APP_NAME=FitFlow
ENVIRONMENT=production
```

3. Under Bindings, add the D1 database:
   - Name: DB
   - Database: fitflow

### 4. Set Up Database

After deployment is live:

```bash
# Run migrations in production
wrangler d1 execute fitflow --remote < migrations/0001_init.sql

# Or use the migration script
wrangler d1 execute fitflow --remote --file db/migrate.ts
```

### 5. Verify Deployment

```bash
# Check deployment status
wrangler deployments list

# Visit your Pages URL
# Test all routes:
# - https://your-domain.pages.dev/dashboard
# - https://your-domain.pages.dev/reports
# - https://your-domain.pages.dev/audit-log
# - https://your-domain.pages.dev/settings
```

## Post-Deployment

### Monitoring

1. **Cloudflare Analytics**
   - View in Cloudflare Dashboard > Analytics
   - Monitor traffic, errors, performance

2. **Error Tracking**
   - Check browser console for client errors
   - Monitor Cloudflare Workers logs

### Optimization

1. **Cache Settings**
   ```
   Page Rules or Caching Rules:
   - Cache static assets: 1 month
   - Cache HTML: 5 minutes
   - No cache for /api/*
   ```

2. **Security**
   - Enable Cloudflare SSL/TLS
   - Set up WAF rules
   - Enable DDoS protection

### Scaling

1. **Database**
   - Monitor D1 usage in Cloudflare Dashboard
   - Upgrade plan if needed
   - Set up replication for redundancy

2. **Function Scaling**
   - Cloudflare automatically scales
   - No manual scaling needed

## Environment Configuration

### Development (.env.local)
```
TIMEZONE=America/Denver
APP_NAME=FitFlow Dev
DATABASE_URL=./db/fitflow.db
```

### Production (Cloudflare)
```
TIMEZONE=America/New_York
APP_NAME=FitFlow
ENVIRONMENT=production
```

## Database Backup

### Local Backup
```bash
# Backup SQLite database
cp db/fitflow.db db/fitflow.db.backup.$(date +%s)
```

### Cloud Backup (D1)
Cloudflare D1 automatically backs up:
- Daily backups (30 days retention)
- Access via Cloudflare Dashboard

To export data:
```bash
wrangler d1 export fitflow --output fitflow-export.sql --remote
```

## Troubleshooting

### Build Fails
```bash
# Check Node version
node --version  # Should be 18+

# Clear cache and rebuild
rm -rf .next node_modules
npm install
npm run build
```

### Database Errors
```bash
# Verify database exists
wrangler d1 list

# Check migrations
wrangler d1 show fitflow --remote

# Run migrations manually
wrangler d1 execute fitflow --remote --file db/migrate.ts
```

### Pages Not Loading
1. Check build output in Cloudflare Dashboard
2. Verify environment variables are set
3. Check browser console for errors
4. Review Cloudflare Worker logs

### Slow Performance
1. Check Cloudflare analytics for bottlenecks
2. Enable database query logging
3. Review Next.js build output
4. Consider upgrading D1 plan

## Rolling Back

### To Previous Version
```bash
# If using git deployment:
git revert <commit-hash>
git push origin main

# Cloudflare automatically redeploys

# Or rollback in Cloudflare Dashboard:
# Pages > Deployments > Select Previous > Rollback
```

## Costs

### Cloudflare Pricing
- **Pages**: Free (10k requests/day free tier)
- **D1**: Free (5GB storage, 25M read, 100k write per month)
- **Workers**: Free (100k requests/day free tier)

For production usage, expect:
- Pages: $0-$20/month
- D1: $0-$10/month
- Total: ~$5-$20/month for typical usage

## Git Workflow

```bash
# Create deployment branch
git checkout -b deploy/production

# Make final changes
npm run build

# Commit
git commit -m "chore: production deployment"

# Push to trigger deployment
git push origin deploy/production

# Create Pull Request
# Review in Cloudflare Pages preview
# Merge to main when ready
```

## CI/CD Pipeline

Cloudflare Pages automatically:
1. Builds on every push to main
2. Deploys to production URL
3. Creates preview URLs for PRs
4. Runs tests (if configured)

Add GitHub Actions for additional checks:

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npm run test:e2e
```

## Support & Resources

- **Cloudflare Docs**: https://developers.cloudflare.com
- **Pages Guide**: https://developers.cloudflare.com/pages
- **D1 Documentation**: https://developers.cloudflare.com/d1
- **Next.js + Cloudflare**: https://nextjs.org/docs/app/api-reference/next-config-js/redirects

---

**Last Updated**: August 19, 2026
**Status**: Ready for Production Deployment
**Estimated Cost**: $5-20/month
