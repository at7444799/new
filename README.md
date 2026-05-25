# CreatorOS AI 🚀

> The all-in-one AI content platform for YouTubers, Instagram creators, small businesses, and product sellers.

![CreatorOS AI](https://img.shields.io/badge/CreatorOS-AI%20Platform-6366f1?style=for-the-badge)
![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react)
![Vite](https://img.shields.io/badge/Vite-7-646CFF?style=for-the-badge&logo=vite)
![TailwindCSS](https://img.shields.io/badge/Tailwind-4-06B6D4?style=for-the-badge&logo=tailwindcss)

## ✨ Features

### 10 AI-Powered Content Tools
1. **🎬 AI Shorts Script Generator** – 60-second scripts for YouTube Shorts & Reels
2. **🎣 Viral Hook Generator** – Stop-the-scroll opening hooks
3. **▶️ YouTube Title Generator** – High-CTR titles that rank
4. **🔍 SEO Description Generator** – Keyword-rich descriptions
5. **#️⃣ Hashtag Generator** – Platform-specific hashtag bundles
6. **🖼️ Thumbnail Prompt Generator** – AI image prompts for thumbnails
7. **📢 Product Ad Copy Generator** – Converting Facebook/Google ads
8. **📝 Blog Post Generator** – Full SEO-optimized blog posts
9. **📸 Instagram Caption Generator** – Engaging captions with CTAs
10. **📅 Content Calendar Generator** – 30-day content plans

### Platform Features
- 🌙 Dark futuristic UI with glassmorphism
- 🔐 Authentication (Supabase Auth ready)
- 💾 Generation history with save & search
- ⚙️ Flexible AI provider (OpenAI, Claude, DeepSeek, NVIDIA, or Mock)
- 💳 Payment ready (Razorpay + Stripe)
- 📱 Fully responsive mobile design
- 🎨 Beautiful animations and neon effects

## 🚀 Getting Started

### Prerequisites
- Node.js 18+ 
- npm or yarn

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/yourusername/creatorosai.git
cd creatorosai

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Edit .env with your API keys (see Configuration section below)

# 4. Start development server
npm run dev
```

The app will be running at `http://localhost:5173`

### Build for Production

```bash
npm run build
```

## ⚙️ Configuration

### Step 1: Basic Setup (No API Key Needed)
The app works out of the box with **Mock AI** – no API key required.
Just run `npm run dev` and start exploring!

### Step 2: Add Real AI (Optional)
Edit your `.env` file:

```env
# Choose your AI provider
VITE_DEFAULT_AI_PROVIDER=openai  # or claude, deepseek, nvidia

# Add your API key
VITE_OPENAI_API_KEY=sk-your-key-here
```

Or set it directly in the app: **Settings → AI Settings → Choose Provider → Add API Key**

### Step 3: Connect Supabase (Optional – for production)
```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

### Step 4: Enable Payments (Optional)
```env
# Razorpay (India)
VITE_RAZORPAY_KEY_ID=rzp_test_...

# Stripe (International)  
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

## 📁 Project Structure

```
creatorosai/
├── public/
│   ├── favicon.svg
│   └── images/
├── src/
│   ├── components/
│   │   ├── auth/
│   │   │   └── ProtectedRoute.tsx    # Auth guard
│   │   ├── layout/
│   │   │   ├── Navbar.tsx            # Public navbar
│   │   │   ├── Sidebar.tsx           # Dashboard sidebar
│   │   │   └── DashboardLayout.tsx   # Dashboard wrapper
│   │   └── ui/
│   │       ├── Button.tsx            # Button component
│   │       ├── GlassCard.tsx         # Glassmorphism card
│   │       ├── Badge.tsx             # Badge component
│   │       └── LoadingSpinner.tsx    # Loading animations
│   ├── context/
│   │   └── AppContext.tsx            # Global state management
│   ├── data/
│   │   └── tools.ts                  # Tool & pricing config
│   ├── pages/
│   │   ├── Home.tsx                  # Landing page
│   │   ├── Features.tsx              # Features page
│   │   ├── Pricing.tsx               # Pricing page
│   │   ├── Login.tsx                 # Login page
│   │   ├── Register.tsx              # Register page
│   │   ├── Dashboard.tsx             # Main dashboard
│   │   ├── ToolPage.tsx              # Individual AI tool
│   │   ├── Results.tsx               # Results page
│   │   ├── History.tsx               # Generation history
│   │   └── Settings.tsx              # User settings
│   ├── services/
│   │   └── aiService.ts              # AI API integrations
│   ├── types/
│   │   └── index.ts                  # TypeScript types
│   ├── App.tsx                       # Root component + routes
│   ├── main.tsx                      # Entry point
│   └── index.css                     # Global styles
├── .env.example                      # Environment template
└── README.md
```

## 💰 Pricing Plans

| Plan | Price | Generations | Features |
|------|-------|-------------|----------|
| **Free** | ₹0 | 10/month | 5 tools |
| **Creator** | ₹199/month | 100/month | All 10 tools |
| **Pro** | ₹499/month | 500/month | API access, 3 seats |
| **Agency** | ₹1499/month | Unlimited | White-label, unlimited seats |

## 🤖 Supported AI Providers

| Provider | Model | Status |
|----------|-------|--------|
| Mock AI | Built-in templates | ✅ Default |
| OpenAI | GPT-4o, GPT-4o-mini | ✅ Ready |
| Claude | Claude 3 Haiku/Sonnet | ✅ Ready |
| DeepSeek | DeepSeek Chat | ✅ Ready |
| NVIDIA NIM | Various models | ✅ Ready |

## 🔧 Backend Integration (Future)

To add a real backend (FastAPI):

```python
# backend/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/api/generate")
async def generate(request: GenerateRequest):
    # Call your AI provider here
    return {"output": "..."}
```

## 📊 Supabase Schema (Optional)

```sql
-- Users table (extends Supabase auth.users)
create table profiles (
  id uuid references auth.users primary key,
  name text,
  plan text default 'free',
  generations_used int default 0,
  generations_limit int default 10,
  created_at timestamp default now()
);

-- Generation history
create table generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  tool_id text not null,
  input text not null,
  output text not null,
  saved boolean default false,
  created_at timestamp default now()
);
```

## 🙏 Credits

- UI inspired by modern SaaS platforms
- Icons by [Lucide React](https://lucide.dev)
- Animations powered by CSS and Framer Motion

## 📄 License

MIT License © 2024 CreatorOS AI

---

Built with ❤️ for creators, by creators.
