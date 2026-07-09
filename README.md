# EasySync Pro - Danea & Shopify

EasySync Pro is a powerful, locally-hosted Electron desktop application designed to streamline the synchronization of inventory and dynamic pricing between Danea EasyFatt (or custom Excel exports) and Shopify. It acts as a robust middleware tool tailored for jewelry e-commerce, offering a built-in Dynamic Pricing Engine to automatically calculate variant prices based on real-time gold quotes (to insert manually), specific weights, and size rules.

## Key Features

- **Dynamic Pricing Engine**: Calculate end-prices for jewelry variants using customizable mathematical formulas (e.g., `PESO * ((PREZZO_FINO * 0.8) + 5.7) * 2`).
- **Live Preview**: Real-time evaluation of formulas within the UI to instantly see the calculated base and discounted prices for minimum, median, and maximum sizes.
- **Rule Management**: Set rules per-product or per-category (fixed weight vs variable weight) with specific size ranges (e.g., EU sizes 8 to 31).
- **Intelligent Rounding**: Built-in math parsing and European locale parsing (`72,50` to `72.50`), with automatic rounding to the nearest integer.
- **Shopify CSV Generation**: Instantly generate Shopify-compatible CSV files ready for bulk import, automatically updating variants, prices, and stock levels.
- **Sheets Mapping**: Columns mapping of the excel main sheet to shopify csv template or set fixed value on specific columns.
- **Setting Import/Export**: Settings import and export to use the application on different devices.

---

## Tech Stack

- **Framework**: Electron (Node.js backend + Chromium frontend)
- **Frontend**: Vanilla HTML5, CSS3 (Custom Design System with CSS Variables), Vanilla JavaScript
- **Backend**: Node.js (IPC communication, file system operations)
- **Data Processing**: 
  - `exceljs` (Parsing and reading `.xlsx` files)
  - `papaparse` (Generating standardized CSVs for Shopify)
- **Security**: Strict Context Isolation with preloaded IPC bridges. Math evaluation executes securely in the Node backend avoiding `unsafe-eval` CSP violations in the renderer.

---

## Prerequisites

- **Node.js**: v18 or higher (v20+ recommended)
- **npm** (comes with Node.js)
- Operating System: Windows, macOS, or Linux (AppImage)

---

## Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/easysync-pro.git
cd easysync-pro
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start Development Server

```bash
npm start
```
This will launch the Electron application locally.

---

## Architecture

### Directory Structure

```text
├── main.js             # Electron main process (Backend, IPC handlers, safe eval)
├── preload.js          # IPC bridge establishing secure Context Isolation
├── renderer.js         # Frontend logic, state management, and UI reactivity
├── index.html          # Application UI markup
├── styles.css          # Design system and theming
├── package.json        # Dependencies and build scripts
└── .gitignore          # Ignored files (node_modules, builds, etc.)
```

### Data Flow & IPC

1. **User Input**: User changes a rule or formula in `index.html`.
2. **Renderer (`renderer.js`)**: Triggers an `updateLivePreview()` event. To avoid CSP violations, it makes an asynchronous call to the backend.
3. **Preload Bridge (`preload.js`)**: Passes the request via `ipcRenderer.invoke('eval-formula')`.
4. **Main Process (`main.js`)**: Securely executes the math evaluation (`Function('return...')`) in the Node environment and returns the result.
5. **UI Update**: The frontend receives the sanitized numeric result and updates the DOM immediately.

---

## Building for Production

To package the application into a standalone executable for your operating system (e.g., `.exe` for Windows, `.AppImage` for Linux), we use `electron-builder`.

```bash
# Build for all platforms specified in package.json
npm run build:all

# Build only for Windows
npm run build:win

# Build only for Linux
npm run build:linux
```

The resulting executables will be generated inside the `dist/` directory (which is ignored by Git).

---

## Troubleshooting

### Linux Vulkan/Wayland Warnings
If you run the app on a modern Linux distribution (using Wayland) and see terminal warnings regarding Vulkan compatibility, this is normal. Hardware acceleration and Vulkan have been explicitly disabled in `main.js` (`app.disableHardwareAcceleration()`) to ensure maximum stability on utility tools and to suppress visual glitches.

### Formula Evaluation Returns "Errore"
Ensure that your variables in the formula exactly match the required nomenclature (e.g., `PREZZO_FINO`, `PESO`). The Live Preview engine handles both dot (`.`) and comma (`,`) decimal separators automatically.
