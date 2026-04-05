# Tracker — Gym & Meal Logger

A personal fitness and nutrition tracking web app built for daily use on both phone and desktop.

**Live:** [gym-project-blue-theta.vercel.app](https://gym-project-blue-theta.vercel.app)

## Tech Stack

- **Frontend:** React 19 + Vite 8 (single-page app)
- **Backend / Database:** Supabase (PostgreSQL + Auth + Storage)
- **Hosting:** Vercel
- **Design:** Responsive layout, blue/gray gradient theme, mobile-first

## Features

### Gym Tracking
- Interactive calendar with workout day markers and monthly count
- Log exercises by muscle group (chest, back, shoulders, arms, legs, core, cardio)
- Record sets, reps, and weight for each exercise
- Edit or delete any exercise entry after creation

### Meal Logging
- Log meals for any date (not just today) via calendar date picker
- Photo upload with cloud storage (Supabase Storage)
- Track nutrients per meal (calories, protein, carbs, fat)
- Diary-style collapsible timeline for browsing meal history
- Edit or delete individual meal entries

### Weekly Menu
- Plan weekly meals with grocery list and recipe source links
- Quick preview card on the meal page, expandable to full modal

### Recipe Library
- Save dishes with ingredients, notes, and source links
- Tag system with presets + custom user-defined tags
- Filter recipes by tag
- Edit or delete saved recipes

### Cloud Sync
- Email + password authentication
- All data synced via Supabase — accessible from any device
- Photos stored in Supabase Storage with public access

### UI / UX
- Responsive: side-by-side layout on desktop (>=768px), single column on mobile
- Gradient background with card-based design for visual depth
- No number input spinners
- Date format: English month + day (e.g. "April 5")

## Getting Started

```bash
npm install
npm run dev
```

## Deploy

```bash
npx vercel --prod
```
