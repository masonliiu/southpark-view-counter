# South Park Profile View Counter

Track your GitHub profile views with South Park characters!

A customizable view counter that displays total view count using South Park characters.

[![Website](https://img.shields.io/badge/Website-Create%20Counter-4caf50?style=for-the-badge&logo=vercel)](https://southpark-view-counter.vercel.app)
[![GitHub](https://img.shields.io/badge/GitHub-View%20Source-000?style=for-the-badge&logo=github)](https://github.com/masonliiu/southpark-view-counter)

## Get Started

Visit **[southpark-view-counter.vercel.app](https://southpark-view-counter.vercel.app)** to create your custom counter with the interactive builder. Simply enter a unique username, customize the appearance to your liking, and copy the generated markdown code to your README.

## How It Works

The counter works by generating a dynamic SVG image on each request. When someone views your GitHub profile (or any page with the counter embedded), the server:

1. Receives a request to `/@your-username`
2. Increments the view count stored in Redis
3. Generates an SVG image with South Park characters holding each digit
4. Returns the SVG, which displays in your README

The counter automatically increments on each view, so your numbers stay up-to-date. View counts are stored persistently using Upstash Redis, ensuring your counter survives server restarts and deployments.

## Features

- **South Park Characters** - Uses your favorite characters as digits
- **Drag & Drop Builder** - Interactive tool to customize character order
- **Real-time Counter** - Automatically increments on each view
- **Dark Mode Support** - Auto-detects system preference
- **Fast & Lightweight** - Optimized SVG images with compression

## Customization Options

| Parameter | Description | Default |
|-----------|-------------|---------|
| `padding` | Number of digits (1-16) | `7` |
| `darkmode` | `0` (light), `1` (dark), `auto` | `auto` |
| `prefix` | Text prefix before digits | - |
| `order` | Character order (comma-separated) | Default order |
| `scale` | Image scale (0.1-2) | `1` |
| `align` | Vertical alignment (`top`, `center`, `bottom`) | `top` |

## Tech Stack

- **Node.js** + **Express** - Server framework
- **Upstash Redis** - Persistent counter storage
- **Sharp** - Image optimization and compression
- **Vercel** - Hosting & deployment

## License

MIT License - feel free to use this project however you'd like!

## Disclaimer

South Park is a trademark of Comedy Partners. This project is not affiliated with, endorsed by, or associated with Comedy Partners or South Park Digital Studios.

---

Made with original artwork

[Star this repo](https://github.com/masonliiu/southpark-view-counter) if you find it cool!

