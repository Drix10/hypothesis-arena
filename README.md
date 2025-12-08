<div align="center">
  <img width="1200" height="475" alt="Hypothesis Arena Banner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
  
  # 🏆 Hypothesis Arena
  
  **Turn your research ideas into publication-ready briefs through AI-powered debate tournaments**
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript)](https://www.typescriptlang.org/)
  [![React](https://img.shields.io/badge/React-19.2-61dafb?logo=react)](https://react.dev/)
  [![Vite](https://img.shields.io/badge/Vite-6.2-646cff?logo=vite)](https://vitejs.dev/)
  
  [Report Bug](https://github.com/drix10/hypothesis-arena/issues) • [Request Feature](https://github.com/drix10/hypothesis-arena/issues)
</div>

---

## 🎯 What is this?

Eight AI researchers with different expertise debate your idea in a tournament bracket. Each round refines the hypothesis until the strongest version wins. You get a complete research brief at the end.

**How it works:**

1. Enter your research idea (+ optional files)
2. AI generates 8 specialized researchers
3. They debate in quarterfinals → semifinals → finals
4. Winner produces a publication-ready brief

---

## ✨ Features

- **8 AI Researchers** - Each with unique expertise and debate style
- **Tournament Bracket** - Quarterfinals → Semifinals → Finals
- **Multi-Dimensional Scoring** - Novelty, feasibility, impact, ethics
- **File Upload** - PDFs, images, text (20MB max)
- **Auto-Save** - Resume anytime after refresh
- **Publication Brief** - Complete research summary
- **Dark Mode UI** - Responsive, accessible, smooth animations

---

## 🚀 Quick Start

**Prerequisites:** Node.js 18+ and a Gemini API key ([get one free](https://aistudio.google.com/apikey))

```bash
git clone https://github.com/drix10/hypothesis-arena.git
cd hypothesis-arena
npm install
npm run dev
```

Open `http://localhost:5173` and enter your API key when prompted. Your key stays in memory only—never saved to disk.

---

## 🛠️ Available Scripts

| Command           | Description                              |
| ----------------- | ---------------------------------------- |
| `npm run dev`     | Start development server with hot reload |
| `npm run build`   | Build production bundle                  |
| `npm run preview` | Preview production build locally         |

---

## 📖 Usage

1. Enter your research idea
2. Upload files (optional)
3. Watch AI researchers debate
4. Get your publication brief

**Keyboard shortcuts:** `↑/↓` navigate, `Enter` opens details, `Esc` closes

---

## 🏗️ Tech Stack

React 19 • TypeScript • Vite • Gemini 2.0 • Tailwind • Recharts

---

## 🔒 Security

- API key stored in memory only (cleared on refresh)
- All API calls client-side (no backend)
- Tournament data stays on your device
- Input sanitization with DOMPurify

---

---

## 🐛 Troubleshooting

**API key issues?** Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

**File upload fails?** Max 20MB, supports PDF/PNG/JPG/TXT

**Build fails?** Delete `node_modules` and run `npm install` again

---

---

## 🤝 Contributing

Fork, create a feature branch, commit, push, and open a PR. Follow TypeScript strict mode and add JSDoc comments.

---

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 📞 Support

[GitHub Issues](https://github.com/drix10/hypothesis-arena/issues) • [Email](mailto:ggdrishtant@gmail.com)

---

<div align="center">
  
  **Built with React, TypeScript, and Gemini**
  
  ⭐ Star if you find this useful
  
</div>
