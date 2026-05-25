# CreatorOS AI — GitHub 24/7 Setup

Your uploaded project is a **React + Vite frontend SaaS UI**. It builds successfully with `npm ci && npm run build`.

## Best 24/7 setup

### Option A — GitHub Pages, free static hosting
Use this if you want the website online 24/7 as a frontend demo.

1. Create a new GitHub repository.
2. Upload all project files.
3. Go to **Settings → Pages → Build and deployment → Source**.
4. Select **GitHub Actions**.
5. Push to the `main` branch.
6. Open the **Actions** tab and wait for **Deploy CreatorOS AI to GitHub Pages** to finish.

Your website will be live on a GitHub Pages URL.

Important: GitHub Pages is only static hosting. It cannot safely run secret AI keys or a backend 24/7.

### Option B — Vercel or Netlify, easiest SaaS hosting
Use this if you want a professional SaaS frontend online 24/7.

Build command:
```bash
npm run build
```

Output folder:
```bash
dist
```

### Option C — Real SaaS with AI/API keys
Do **not** put real keys like NVIDIA, OpenAI, Razorpay secret, Stripe secret, or Resend key inside `VITE_` variables in frontend code. Anything starting with `VITE_` becomes visible to website visitors.

For real production, use:
- Frontend: Vercel / Netlify / GitHub Pages
- Backend API: Render / Railway / Fly.io / Google Cloud Run
- Database/Auth: Supabase
- Secrets: Backend environment variables only

## Local run

```bash
npm ci
npm run dev
```

## Production build test

```bash
npm ci
npm run build
```

## GitHub upload commands

```bash
git init
git add .
git commit -m "Initial CreatorOS AI project"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

## For automation / scheduled jobs

GitHub Actions can run scheduled jobs, but it is not a 24/7 server. It is good for tasks like daily content generation or posting schedules, not for keeping a web backend running permanently.

Example schedule:
```yaml
on:
  schedule:
    - cron: "0 */6 * * *"
```

For always-on APIs, use Render/Railway/Fly.io/Cloud Run.
