# 🚀 Przewodnik Wdrożenia - Zarządzanie Czarterami Jachtów

## Spis Treści
1. [Architektura](#architektura)
2. [Szybki Start](#szybki-start)
3. [Wdrożenie na Railway](#wdrożenie-na-railway)
4. [Wdrożenie na Heroku](#wdrożenie-na-heroku)
5. [Konfiguracja Email](#konfiguracja-email)
6. [Bezpieczeństwo](#bezpieczeństwo)
7. [FAQ](#faq)

---

## Architektura

```
┌─────────────────────────────────────────────────────────────────┐
│                    PRZEGLĄDARKI KLIENTÓW                        │
│                   (HTML + JavaScript)                           │
│                                                                  │
│  ┌─────────────────────┐      ┌──────────────────────────┐     │
│  │  Moduł Czarterobiorcy│      │  Moduł Klubowy (JWT)     │     │
│  │  - Kalkulator ceny  │      │  - Logowanie             │     │
│  │  - Rezerwacja       │      │  - Kalendarz             │     │
│  │  - Podsumowanie     │      │  - Zarządzanie           │     │
│  └─────────────────────┘      └──────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                            │
                   HTTPS API (REST)
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   BACKEND (Node.js + Express)                   │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ API Routes   │  │ JWT Auth     │  │ Email Service│          │
│  │ /api/*       │  │ /api/auth    │  │ (Nodemailer) │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                  │
│  ┌──────────────────────────────────────┐                      │
│  │   In-Memory Storage (DB później)     │                      │
│  │   - Rezerwacje                       │                      │
│  │   - Administratorzy                  │                      │
│  └──────────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
                            │
                   ┌────────┼────────┐
                   │                 │
                   ▼                 ▼
            ┌──────────────┐  ┌──────────────┐
            │ Gmail SMTP   │  │ Logs (stdout)│
            │ (Emaile)     │  │              │
            └──────────────┘  └──────────────┘
```

**Komponenty:**

- **Frontend**: Plik HTML samodzielny (`yacht_charter_app.html`) - localStorage do przechowywania rezerwacji
- **Backend**: Express.js na Railway/Heroku/Render - JWT do autentykacji, Nodemailer do emaili
- **Email**: Gmail SMTP (darmowe) - powiadomienia dla klientów i administratorów
- **Storage**: In-memory w fazie prototypu, baza danych (PostgreSQL) w produkcji

---

## Szybki Start

### 1. Przygotowanie Środowiska Lokalnego

```bash
# Sklonuj lub pobierz pliki
mkdir yacht-charter-app
cd yacht-charter-app

# Skopiuj pliki:
# - server.js
# - package.json
# - .env
# - Dockerfile
# - docker-compose.yml
```

### 2. Instalacja Zależności

```bash
npm install
```

### 3. Konfiguracja .env

```bash
# Edytuj .env (patrz sekcja Konfiguracja Email poniżej)
cp .env.example .env
nano .env
```

### 4. Uruchomienie Lokalnie

```bash
# Z nodemonem (auto-reload)
npm run dev

# Lub zwykły start
npm start
```

Server będzie dostępny na `http://localhost:3000`

### 5. Testowanie API

```bash
# Logowanie
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"klub123"}'

# Powinno zwrócić:
# {"token":"eyJ0eXAi...", "message":"Zalogowano pomyślnie"}
```

---

## Wdrożenie na Railway

Railway to najprostsza opcja dla Ciebie - bezpłatny tier, obsługa GitHub, 1-klik deploy.

### 1. Rejestracja na Railway

- Przejdź do [railway.app](https://railway.app)
- Zaloguj się przez GitHub
- Utwórz nowy projekt

### 2. Przygotowanie Repozytorium

```bash
# Jeśli nie masz jeszcze gita
git init
git add .
git commit -m "Initial commit"

# Utwórz repo na GitHub
# (możesz zrobić to przez webą)

# Push to GitHub
git remote add origin https://github.com/TWOJ_LOGIN/yacht-charter-app.git
git branch -M main
git push -u origin main
```

### 3. Deploy na Railway

1. W Railway kliknij **New Project** → **Deploy from GitHub**
2. Wybierz swoje repozytorium
3. Railway automatycznie wykryje `package.json` i `Dockerfile`
4. W **Environment** dodaj zmienne:
   ```
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASSWORD=app-specific-password
   JWT_SECRET=super-tajne-haslo-zmien-to
   ADMIN_PASSWORD=klub123
   NODE_ENV=production
   ```
5. Kliknij **Deploy**

### 4. Uzyskanie Public URL

- W Railway panel, przejdź do **Settings** → **Domains**
- Kliknij **Generate Domain**
- Otrzymasz URL typu `https://yacht-api-prod-abc123.up.railway.app`

### 5. Połączenie Frontendu

W `yacht_charter_app.html`, na górze pliku JavaScript dodaj zmienną:

```javascript
const API_BASE_URL = 'https://yacht-api-prod-abc123.up.railway.app';
```

Potem zmień wszystkie `fetch` na:

```javascript
fetch(API_BASE_URL + '/api/reservations', {...})
```

---

## Wdrożenie na Heroku

Heroku ma teraz bezpłatny tier z limitami, ale nadal wart rozpatrzenia.

### 1. Rejestracja i Setup

```bash
# Instalacja Heroku CLI
# https://devcenter.heroku.com/articles/heroku-cli

heroku login
heroku create yacht-charter-app-production
```

### 2. Dodanie Variables

```bash
heroku config:set EMAIL_USER=your-email@gmail.com
heroku config:set EMAIL_PASSWORD=app-specific-password
heroku config:set JWT_SECRET=super-tajne-haslo
heroku config:set ADMIN_PASSWORD=klub123
heroku config:set NODE_ENV=production
```

### 3. Deploy

```bash
git push heroku main
```

### 4. Sprawdzenie Logów

```bash
heroku logs --tail
```

---

## Konfiguracja Email

Aby wysyłać emaile, musisz skonfigurować Gmail lub inny serwis SMTP.

### Opcja 1: Gmail SMTP (Rekomendowane)

1. **Włącz 2-faktorową autentykację** na koncie Google
2. **Wygeneruj App Password**:
   - Przejdź do [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   - Wybierz "Mail" i "Windows Computer"
   - Google wygeneruje 16-znakowe hasło
3. **Dodaj do .env**:
   ```
   EMAIL_USER=twoj-email@gmail.com
   EMAIL_PASSWORD=xxxx xxxx xxxx xxxx
   ```

### Opcja 2: Outlook/Hotmail

```
EMAIL_USER=twoj-email@outlook.com
EMAIL_PASSWORD=twoje-haslo
```

W `server.js` zmień:
```javascript
const transporter = nodemailer.createTransport({
    service: 'outlook',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});
```

### Opcja 3: SendGrid (najlepszy dla produkcji)

1. Zarejestruj się na [sendgrid.com](https://sendgrid.com)
2. Utwórz API Key
3. W `server.js`:
```javascript
const transporter = nodemailer.createTransport({
    host: 'smtp.sendgrid.net',
    port: 587,
    auth: {
        user: 'apikey',
        pass: process.env.SENDGRID_API_KEY
    }
});
```

---

## Bezpieczeństwo

⚠️ **WAŻNE** - przeczytaj przed wdrożeniem!

### 1. Zmień Domyślne Hasła

W `.env`:
```bash
# ❌ ZMIEŃ TE:
ADMIN_PASSWORD=klub123
JWT_SECRET=your-secret-key-change-this

# ✅ NA SILNE HASŁA:
ADMIN_PASSWORD=KlubZeglarski2024#SecurePass
JWT_SECRET=abc123def456ghi789jkl012mnopqrs789tuvwxyz
```

### 2. Włącz HTTPS

- Railway/Heroku obsługują HTTPS domyślnie ✅
- Nie hostuj na zwykłym HTTP

### 3. Chroń Email

- **Nigdy** nie wysyłaj emaili bez szyfrowania
- Używaj `service: 'gmail'` a nie `host: 'smtp.gmail.com'`
- Dla App Passwords nie bój się - zmień je co 90 dni

### 4. Dodaj CORS Security

W `server.js`, zmień:
```javascript
app.use(cors());
```

Na:
```javascript
app.use(cors({
    origin: ['https://twoja-domena.com', 'https://app.twoja-domena.com'],
    credentials: true
}));
```

### 5. Rate Limiting (dla przyszłości)

```bash
npm install express-rate-limit
```

### 6. Walidacja Danych

Zawsze waliduj wejście:
```javascript
const validator = require('validator');

if (!validator.isEmail(email)) {
    return res.status(400).json({ error: 'Zły email' });
}
```

---

## Integracja z Frontendem

W `yacht_charter_app.html`, zmień te sekcje:

### 1. Dodaj API URL na górze

```javascript
const API_BASE_URL = 'https://yacht-api-prod.railway.app';
```

### 2. Zastąp wysyłanie rezerwacji

```javascript
async function sendReservationToClub() {
    // ... walidacja ...
    
    const payload = {
        yacht: currentReservation.yacht,
        date: currentReservation.date,
        startTime: currentReservation.startTime,
        hours: currentReservation.hours,
        tackle: currentReservation.tackle,
        skipper: currentReservation.skipper,
        totalPrice: currentReservation.totalPrice,
        customerName: document.getElementById('customerName').value,
        customerEmail: document.getElementById('customerEmail').value,
        customerPhone: document.getElementById('customerPhone').value
    };

    try {
        const response = await fetch(API_BASE_URL + '/api/reservations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        
        if (response.ok) {
            showAlert('✅ Rezerwacja wysłana! Email potwierdzający zostanie wysłany wkrótce.', 'success');
            resetForm();
        } else {
            showAlert('❌ Błąd: ' + data.error, 'error');
        }
    } catch (err) {
        showAlert('❌ Błąd sieci: ' + err.message, 'error');
    }
}
```

### 3. Logowanie Admina z API

```javascript
async function adminLogin() {
    const password = document.getElementById('adminPassword').value;

    try {
        const response = await fetch(API_BASE_URL + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });

        const data = await response.json();

        if (response.ok) {
            localStorage.setItem('adminToken', data.token);
            adminLoggedIn = true;
            // ... reszta logowania ...
        } else {
            showAlert('Błędne hasło!', 'error');
        }
    } catch (err) {
        showAlert('Błąd sieci: ' + err.message, 'error');
    }
}
```

---

## FAQ

### P: Czy mogę hostować bez backendu?

**O:** Frontend działał będzie samodzielnie (localStorage), ale emaile wymagają backendu. Możesz użyć serwisu do wysyłania emaili (Formspree, EmailJS).

### P: Czy mogę używać bazy danych?

**O:** Tak! Dodaj PostgreSQL:
```bash
npm install pg
```

Przejdź do Railway → Marketplace → Add PostgreSQL. Zmień storage na queries do bazy.

### P: Jak ustawić własną domenę?

**O:** 
- Railway: Settings → Domains → Custom Domain
- Heroku: `heroku domains:add charter.twoja-domena.com`
- Dodaj CNAME record w DNS dostawcy domeny

### P: Czy jest demo?

**O:** Tak! Otwórz `yacht_charter_app.html` w przeglądarce. Wszystko działa lokalnie z localStorage.

### P: Bezpieczeństwo haseł?

**O:** Haszuj hasła!
```bash
npm install bcryptjs
```

```javascript
const bcrypt = require('bcryptjs');

const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);
// Porównaj: await bcrypt.compare(providedPassword, hashedPassword);
```

---

## Checklist Wdrożenia

- [ ] Zmieniono wszystkie domyślne hasła
- [ ] Skonfigurowano Email (Gmail App Password)
- [ ] Frontend poprawnnie wysyła do API
- [ ] Backend uruchomiony (Railway/Heroku)
- [ ] HTTPS włączony
- [ ] CORS skonfigurowany
- [ ] Testy emaili działają
- [ ] Testy rezerwacji działają
- [ ] Admin panel loguje się
- [ ] Kalendarz wyświetla rezerwacje

---

## Wsparcie

**Problemy?**

1. Sprawdź logi: `heroku logs --tail` lub Railway dashboard
2. Testuj lokalnie: `npm run dev`
3. Sprawdź zmienne .env: `echo $EMAIL_USER`
4. Sprawdź CORS: przeglądarki → Console → Network

Powodzenia! ⛵

