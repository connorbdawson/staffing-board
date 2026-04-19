# Staffing Board

Tablet-friendly staffing and scheduling for small businesses with fewer than 20 employees.

## What it does

- Manage employees, wages, priorities, and weekly hour limits
- Track recurring availability, recurring unavailability, and one-time exceptions
- Set business hours and staffing requirements by time block
- Generate a weekly schedule using a simple rule-based engine
- Flag understaffed periods, invalid configuration, and hour shortfalls
- Show projected labor cost by shift, day, employee, and week
- Export the schedule calendar to PDF from the schedule screen
- Keep Google Drive backup and restore actions in a compact menu instead of a large on-page panel
- Store state locally in the browser and support JSON import/export for moving setup between devices

## Why this stack

This app is built as a small Next.js web app with client-side persistence in `localStorage`.
That keeps it easy to run locally, easy to deploy, and fast enough for a tablet-first owner workflow.
Because the app is now static, it can be hosted on a free static platform.

## Local setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the app:
   ```bash
   npm run dev
   ```
3. Open the local URL in Safari on an iPad or in a desktop browser for testing.

## First-time GitHub setup

If you have never used GitHub before, this is the simplest path:

1. Create a free GitHub account at `github.com`
2. Create a new repository for this project
3. Upload or push this code into that repository
4. Keep the repository public for the free GitHub Pages option
5. Turn on GitHub Pages in the repo settings and choose GitHub Actions as the source
6. Push any future code changes to the same repo so GitHub Pages redeploys automatically

For the iPad user, you will share the GitHub Pages URL, not a file to download.

## Packaging and iPad use

Yes, this can be handed to someone else to use on an iPad.

- The app is a web app, so the normal delivery path is a hosted URL
- On an iPad, the user opens that URL in Safari and can add it to the Home Screen for app-like use
- The current build is not an App Store package or a native `.ipa`
- If you want a true native iPad app later, we would wrap the web app in a native shell or rebuild it in a mobile stack
- For this version, the easiest handoff is a URL plus an exported JSON file if you want to transfer starter data

## GitHub deployment

The cleanest zero-dollar update flow is:

1. Put the repo on GitHub
2. Make the repository public so GitHub Pages can publish it on the free plan
3. Use the included GitHub Actions workflow to deploy the static build to GitHub Pages
4. Push changes to GitHub whenever you update the app
5. Let GitHub Pages redeploy automatically from the same branch

That means you can keep improving the app here and the iPad user will keep opening the same URL.

If you later choose a different static host, the app still builds as a static export.

Important privacy note:

- The website URL will be public
- Anyone with the URL can open the app
- The scheduled data itself stays in the user's browser unless they export it or back it up to Google Drive

## Seed data

The app starts with roughly 10 employees, weekday business hours, and sample staffing blocks.
Use the "Reset to seed data" button if you want to restore the default dataset.

## Scheduling model

Assumptions:

- Scheduling happens by weekly time block rather than by arbitrary shift length
- A staffing requirement block can require more than one employee
- Weekly availability is treated as the default working window
- Weekly unavailability always blocks scheduling
- One-time exceptions can mark an employee as available or unavailable on a specific date
- Higher-priority employees are preferred for more hours
- Employees below their preferred minimum hours get a strong scheduling boost
- Employees are never scheduled outside availability or above their maximum allowed hours

Data model:

- `Employee`
- `EmployeeAvailability`
- `BusinessHours`
- `StaffingRequirement`
- `ScheduleAssignment`
- `ScheduleAlert`

## iPad compatibility

The UI uses large touch targets, responsive sections, and no desktop-only interactions.
It is designed to work in both iPad portrait and landscape, including Safari.

For home-screen use on iPad:

- The app ships with a web manifest
- A lightweight service worker is included for app-shell caching
- Safari can add the app to the home screen from the Share menu

## Deployment recommendation

The simplest hosted deployment for this version is a free static host such as Cloudflare Pages, Netlify, or Vercel Hobby:

1. Push the repo to GitHub
2. Deploy the static site build to the host
3. Share the published HTTPS URL with the iPad user

That gives the owner a shareable HTTPS URL that works well on iPad Safari and supports home-screen installation. If you later want shared multi-device editing with the same live data, we can add a real backend and database, which is the part that typically costs money.

## Google Drive backup

You can optionally add a Google Drive backup button for recovery copies.

To enable it:

1. Create a Google OAuth client for a web app
2. Add your authorized deployment domain and local dev origin in Google Cloud
3. Set `NEXT_PUBLIC_GOOGLE_CLIENT_ID` in your deployment environment
4. Open the app and use the `Google Drive` menu, then `Connect Google Drive` and `Back up now`

Important:

- Drive is used as a recovery copy, not the live database
- The live working copy still lives in the browser so the app stays fast and simple
- The user must sign in to Google on that device before Drive backup or restore works
- If you use GitHub Pages, the workflow sets the correct base path automatically so the app can resolve its manifest and service worker

## Notes

- The app keeps a browser cache in `localStorage`
- The app also stores an automatic backup copy in browser storage
- The app also lets you export and import the current state as JSON
- The schedule screen includes a calendar-style view and an `Export calendar PDF` action that uses the browser print dialog
- For the simplest free use case, give the business owner one hosted URL and let them install the site to the iPad Home Screen from Safari
- Ordinary app code updates should not wipe the saved browser data, but the export/import option is there as a manual recovery path
- If Google Drive backup is enabled, the user can keep a second recovery copy in Drive
