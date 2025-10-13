# WAM — Water Quality Monitor (demo)

Quick start:
1. cd wam-dashboard
2. npm install
3. npm run dev
4. Open the network URL Vite prints (http://<your-pc-ip>:5173) on your phone. Ensure both devices are on the same Wi-Fi.

Notes:
- Demo auth uses localStorage, replace with Firebase/Auth0 for production.
- To add more languages, edit src/i18n.js.
- To connect real sensors, add a backend API that accepts POSTs from ESP32/edge devices and add a fetch/WebSocket to the frontend.
