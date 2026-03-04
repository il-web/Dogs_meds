# 🐕💊 DogMeds

> **⚠️ NOTICE: This is a personal project built for my family's specific needs. It is not designed, tested, or intended for general public use. Use at your own risk — do not rely on this for critical medication management without your own verification.**

---

A family medication tracking system for a dog with epilepsy. Includes a mobile-first PWA web app and a physical ESP32 button with OLED display.

Built to track 4 daily medication doses and make sure no one in the family misses or double-doses.

---

## ✨ Features

### Web App (PWA)
- **Single big button** that changes based on current dose status — give now, give early, already given, waiting
- **4 daily doses** — 07:30, 15:30, 19:30, 23:30
- **Early dosing** — 20-minute window before scheduled time
- **Push notifications** — reminders every 5 minutes until the pill is given
- **Multi-user** — each family member registers their name
- **History log** — who gave the pill and when
- **Auto-sync** — refreshes from server every 30 seconds
- **Hebrew RTL interface**

### ESP32 + OLED
- **Physical button** — one press sends to the server
- **0.96" OLED display** — shows status, checkmark on success, X on error
- **Deep Sleep mode** — ~10μA power draw while sleeping, battery lasts months
- **Smart sync** — checks server on wake to avoid duplicates
- **Duplicate prevention** — if already given, shows "Already given" and blocks sending

---

## 🛠️ Tech Stack

| Component | Technology |
|-----------|-----------|
| Frontend | HTML/CSS/JS (PWA) |
| Backend | Supabase (PostgreSQL + REST API) |
| Hosting | Vercel |
| Hardware | ESP32-WROOM-32 + SSD1306 OLED |
| Fonts | Heebo, Secular One |

---

## 📁 Project Structure

```
├── index.html              # Web app (PWA)
├── manifest.json           # PWA manifest
├── vercel.json             # Vercel config (cache headers)
├── icon-192.png            # App icon 192x192
├── icon-512.png            # App icon 512x512
├── debug.html              # Connection test page
└── esp32/
    └── dog_meds_esp32.ino  # ESP32 firmware
```

---

## 🚀 Setup

### Web App

1. Create a [Supabase](https://supabase.com) project
2. Run this SQL:
```sql
CREATE TABLE med_logs (
  id SERIAL PRIMARY KEY,
  given_by TEXT NOT NULL,
  given_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE med_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all" ON med_logs
  FOR ALL USING (true) WITH CHECK (true);
```
3. Update `SUPA_URL` and `SUPA_KEY` in `index.html`
4. Push to GitHub and deploy on Vercel

### ESP32

**Hardware:**
- WeMos/LOLIN ESP32 with built-in OLED (or ESP32 + external SSD1306)
- Button — GPIO 14 → GND

**Required libraries (Arduino IDE):**
- Adafruit SSD1306
- Adafruit GFX Library

**Instructions:**
1. Open `esp32/dog_meds_esp32.ino` in Arduino IDE
2. Change `WIFI_SSID` and `WIFI_PASS`
3. Select board: ESP32 Dev Module
4. Upload

---

## 📱 Usage

### Web App
1. Open the site — first time you'll be asked to enter your name
2. When it's time — press the big green button
3. Confirm the dose
4. View history at the bottom

### ESP32
1. Press the physical button
2. Device wakes up, connects to WiFi, checks the server
3. If not given yet — sends automatically and shows ✓
4. If already given — shows "Already given" + next dose time
5. Returns to Deep Sleep after 10 seconds

---

## ⚡ ESP32 Power Consumption

| State | Draw |
|-------|------|
| Deep Sleep | ~10μA |
| Awake (WiFi + send) | ~150mA for ~3 seconds |
| **Average** | **~0.1mA** |

A 5000mAh power bank will last **months** with normal use.

---

## 🔧 Customization

### Dose times
In `index.html`:
```javascript
const DOSES = [
    { hour: 7, minute: 30, label: 'בוקר' },
    { hour: 15, minute: 30, label: 'צהריים' },
    { hour: 19, minute: 30, label: 'ערב' },
    { hour: 23, minute: 30, label: 'לילה' },
];
```

In `dog_meds_esp32.ino`:
```cpp
const int DOSE_HOURS[]   = {7,  15, 19, 23};
const int DOSE_MINUTES[] = {30, 30, 30, 30};
```

### Early dose window
```javascript
const EARLY_MIN = 20; // minutes before scheduled time
```

---

## 📄 License

MIT License — see [LICENSE](LICENSE)
