# TuRed Tecnicos App

![PWA](https://img.shields.io/badge/PWA-Offline--First-5A0DC8?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)
![GitHub Pages](https://img.shields.io/badge/Deploy-GitHub%20Pages-blue?style=for-the-badge)

**Aplicación Web Progresiva para soporte técnico de campo.**

Calcula tarifas sin conexión, genera comprobantes imprimibles (A4), incluye QR para visualización web y sincroniza datos automáticamente al reconectar.

🔗 **[App en vivo](https://turedinternet.github.io/TuRedTecnicosApp/)**

---

## Features

- **Offline-First** — Funciona sin conexión a internet. Los comprobantes se guardan localmente y se sincronizan al reconectar.
- **Comprobantes A4** — Generación de presupuestos legibles en celular, PC e impresión.
- **Código QR** — Cada comprobante incluye un QR con link web para visualización remota.
- **Panel de Administrador** — CRUD de técnicos, vista global de comprobantes, rendición de caja y gestión de clientes.
- **Cuotas** — Soporte para planes de pago parciales con info de cuotas en el comprobante.
- **Modo Demo** — Prueba la app sin Firebase configurado (datos en localStorage).
- **PWA instalable** — Se instala en el celular como una app nativa.
- **Mobile-First** — Diseñada para usarse en campo, desde un celular.

---

## Stack

| Capa | Tecnología |
|------|------------|
| Frontend | Vanilla JS + ES Modules |
| Backend | Firebase (Auth + Firestore) |
| QR | qrcode-generator |
| Print | CSS @media print (A4) |
| PWA | Service Worker + manifest.json |
| Hosting | GitHub Pages |

---

## Getting Started

### Prerrequisitos

- [Node.js](https://nodejs.org/) v18+ (solo si querés usar Vite para dev/build)
- Una cuenta de [Firebase](https://console.firebase.google.com/) (opcional, la app funciona en modo demo sin Firebase)

### Instalación

```bash
# Clonar el repositorio
git clone https://github.com/turedinternet/TuRedTecnicosApp.git
cd TuRedTecnicosApp

# Instalar dependencias (opcional)
npm install
```

### Configurar Firebase

1. Crear un proyecto en Firebase Console
2. Habilitar **Authentication** (método Email/Password)
3. Crear una base de datos **Firestore**
4. Copiar las credenciales de tu proyecto al archivo `config.js`:

```js
const firebaseConfig = {
  apiKey: "TU_API_KEY",
  authDomain: "TU_PROYECTO.firebaseapp.com",
  projectId: "TU_PROJECT_ID",
  storageBucket: "TU_PROYECTO.appspot.com",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID"
};
```

5. Desplegar las reglas de Firestore en Firebase Console

### Ejecutar

```bash
# Opción 1: Con Vite (dev server)
npm run dev

# Opción 2: Sin dependencias
# Abrir index.html con Live Server o:
python -m http.server 5500
```

> Si `config.js` tiene credenciales de placeholder, la app entra automáticamente en **Modo Demo**.

---

## Estructura del Proyecto

```
├── index.html          # SPA completa (Login, Panel, Comprobante, Admin)
├── app.js              # Controlador principal
├── style.css           # Estilos premium (Glassmorphism, gradientes)
├── config.js           # Configuración Firebase (credenciales)
├── sw.js               # Service Worker (Stale-While-Revalidate)
├── manifest.json       # PWA manifest
├── tarifas.json        # Tarifario editable
├── qrcode.min.js       # Librería QR
├── icon-192.png        # Icono PWA 192x192
├── icon-512.png        # Icono PWA 512x512
├── Logo TuRed completo.png      # Header comprobante
└── Logo TuRed Minimalista.png   # Icono login + PWA
```

---

## Cómo Funciona

### Técnico de Campo

1. **Login** con credenciales (o modo demo)
2. **Selecciona servicios/materiales** del tarifario
3. **Completa datos del cliente** (nombre, dirección, teléfono)
4. **Configura cobro** (efectivo, transferencia, saldo pendiente o a favor)
5. **Genera comprobante** — se guarda offline y se sincroniza al reconectar
6. **Imprime A4** o comparte el **QR** con el cliente

### Administrador

1. **Gestiona técnicos** — crear, editar, cambiar contraseña, eliminar
2. **Ve todos los comprobantes** — con filtros por técnico, estado y fecha
3. **Rendición de caja** — resumen de cobros por día
4. **Gestión de clientes** — directorio centralizado

### Sync Offline → Online

```
1. Comprobante se guarda en localStorage (SIEMPRE primero)
2. Si hay conexión → se envía a Firestore (fire-and-forget)
3. Si no hay conexión → queda como "pendiente_sincronizacion"
4. Al reconectar → sync automática al servidor
```

---

## Deploy

El proyecto se despliega automáticamente vía **GitHub Pages**:

1. Hacer push a la rama `main`
2. GitHub Pages builda y despliega desde la raíz
3. La app queda disponible en: `https://<tu-usuario>.github.io/TuRedTecnicosApp/`

---

## License

Este proyecto está licenciado bajo la [MIT License](LICENSE).

---

## Autor

**[armandogg24](https://github.com/armandogg24)** — Armando Gonzalez
