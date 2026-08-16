const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        }
    }
}));

// ============================================
// CONFIGURATION
// ============================================

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'klub123';
const SKIPPER_PASSWORD = process.env.SKIPPER_PASSWORD || 'skipper123';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://www.jachtoczart.eu';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ BRAK SUPABASE_URL lub SUPABASE_SERVICE_KEY w zmiennych środowiskowych! Baza danych nie będzie działać.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
});

// ============================================
// MIDDLEWARE
// ============================================

function verifyAdminToken(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Brak tokenu' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Brak uprawnień administratora' });
        }
        req.admin = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Nieprawidłowy token' });
    }
}

// Dopuszcza zarówno admina, jak i opiekuna (skippera)
function verifyAnyToken(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Brak tokenu' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Nieprawidłowy token' });
    }
}

// ============================================
// MAPOWANIE WIERSZY BAZY (snake_case) NA FORMAT FRONTENDU (camelCase)
// ============================================

function mapReservation(row) {
    return {
        id: row.id,
        yacht: row.yacht,
        date: row.date,
        startTime: row.start_time,
        hours: row.hours,
        tackle: row.tackle,
        skipper: row.skipper,
        totalPrice: row.total_price,
        customerName: row.customer_name,
        customerEmail: row.customer_email,
        customerPhone: row.customer_phone,
        status: row.status,
        admin: row.admin || null,
        createdAt: row.created_at,
        isClubReservation: row.is_club_reservation || false,
        isCourseSession: row.is_course_session || false
    };
}

function mapUnavailability(row) {
    return {
        id: row.id,
        adminId: row.admin_id,
        date: row.date
    };
}

// ============================================
// WYKRYWANIE KOLIZJI CZASOWYCH REZERWACJI
// ============================================

const DAY_START_MINUTES = 10 * 60; // 10:00 - najwcześniejszy możliwy start
const DAY_END_MINUTES = 20 * 60;   // 20:00 - sprzęt musi być zdany najpóźniej o tej godzinie

// Klub potrzebuje minimum 36h na przygotowanie rezerwacji - dotyczy WYŁĄCZNIE rezerwacji
// składanych przez klientów (formularz publiczny). Nie dotyczy akcji administratora
// (rezerwacje klubowe, sesje kursu, ręczna edycja) - tam decyduje wiedza i kontekst admina.
const MIN_HOURS_NOTICE = 36;

// Liczy "teraz" w czasie polskim (Europe/Warsaw), niezależnie od strefy czasowej kontenera
// na Railway (domyślnie UTC) - z uwzględnieniem automatycznej zmiany czasu zima/lato.
function getWarsawNowParts() {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Warsaw',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = fmt.formatToParts(new Date());
    const get = type => parseInt(parts.find(p => p.type === type).value);
    return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute') };
}

// Zwraca liczbę godzin (może być ułamkowa) pomiędzy "teraz" (czas polski) a podanym
// terminem rezerwacji (data + godzina startu, też interpretowane jako czas polski).
function hoursUntilReservation(dateStr, startTime) {
    const [ry, rm, rd] = dateStr.split('-').map(Number);
    const [rh, rmi] = startTime.split(':').map(Number);
    const reservationMs = Date.UTC(ry, rm - 1, rd, rh, rmi);

    const now = getWarsawNowParts();
    const nowMs = Date.UTC(now.y, now.m - 1, now.d, now.h, now.mi);

    return (reservationMs - nowMs) / (60 * 60 * 1000);
}

const YACHT_PRICES = { enn: 80, first: 80, omega: 80 };
const TACKLE_PRICE = 50;
const SKIPPER_HOURLY_PRICE = 50;

// Jachty "enn" i "first" traktowane jako zamienne przy kolizji terminu
const INTERCHANGEABLE_YACHT = { enn: 'first', first: 'enn' };

// Omega ma obowiązkowe taklowanie - nie da się zarezerwować bez niego.
// Wymuszane tutaj (backend), niezależnie od tego co przesłał frontend,
// żeby żadna ścieżka (formularz klienta, edycja admina, itd.) nie mogła tego ominąć.
const YACHTS_WITH_MANDATORY_TACKLE = ['omega'];

function enforceMandatoryTackle(yacht, tackle) {
    if (YACHTS_WITH_MANDATORY_TACKLE.includes(yacht)) return true;
    return Boolean(tackle);
}

function calculateTotalPrice(yacht, hours, tackle, skipper) {
    let total = YACHT_PRICES[yacht] * hours;
    if (tackle) total += TACKLE_PRICE;
    if (skipper) total += SKIPPER_HOURLY_PRICE * hours;
    return total;
}

// Podział przychodu: wynajem jachtu -> klub, taklowanie + asysta skippera -> opiekun.
// Liczone raz, w momencie tworzenia rezerwacji, i zapisywane na stałe w bazie
// (nie przeliczane dynamicznie przy raportach - stabilność księgowa mimo przyszłych zmian cennika).
function calculateRevenueSplit(yacht, hours, tackle, skipper) {
    const clubRevenue = YACHT_PRICES[yacht] * hours;
    let skipperRevenue = 0;
    if (tackle) skipperRevenue += TACKLE_PRICE;
    if (skipper) skipperRevenue += SKIPPER_HOURLY_PRICE * hours;
    return { clubRevenue, skipperRevenue };
}

function timeToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

function minutesToTime(mins) {
    const h = Math.floor(mins / 60).toString().padStart(2, '0');
    const m = (mins % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
}

// Sprawdza czy [newStart, newEnd) nakłada się z [exStart, exEnd) dla którejkolwiek z istniejących rezerwacji
function findCollision(newStartMinutes, newEndMinutes, existingReservations) {
    return existingReservations.find(res => {
        const exStart = timeToMinutes(res.start_time);
        const exEnd = exStart + res.hours * 60;
        return exStart < newEndMinutes && newStartMinutes < exEnd;
    });
}

// Szuka najwcześniejszego wolnego okna tego samego dnia, mieszczącego żądany czas trwania,
// w godzinach pracy 10:00-20:00
function findEarliestAvailableSlot(requestedHours, existingReservations) {
    const requestedDuration = requestedHours * 60;
    const sorted = [...existingReservations].sort(
        (a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time)
    );

    let candidate = DAY_START_MINUTES;

    for (const res of sorted) {
        const exStart = timeToMinutes(res.start_time);
        const exEnd = exStart + res.hours * 60;

        if (candidate + requestedDuration <= exStart) {
            return minutesToTime(candidate);
        }
        candidate = Math.max(candidate, exEnd);
    }

    if (candidate + requestedDuration <= DAY_END_MINUTES) {
        return minutesToTime(candidate);
    }

    return null; // brak wolnego okna tego dnia dla żądanej długości czarteru
}

// ============================================
// EMAIL SENDING VIA RESEND (HTTPS API - działa na Railway)
// ============================================

async function sendEmail(to, subject, html) {
    if (!RESEND_API_KEY) {
        console.error('Email error: RESEND_API_KEY nie jest ustawiony');
        return;
    }

    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: EMAIL_FROM,
                to: [to],
                subject: subject,
                html: html
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('Email error (Resend):', data);
        } else {
            console.log(`Email sent to ${to}, id: ${data.id}`);
        }
    } catch (err) {
        console.error('Email error (network):', err.message);
    }
}

// ============================================
// TELEGRAM - POWIADOMIENIA DLA OPIEKUNÓW (HTTPS API - działa na Railway)
// ============================================

async function sendTelegramMessage(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error('Telegram error: TELEGRAM_BOT_TOKEN lub TELEGRAM_CHAT_ID nie jest ustawiony');
        return;
    }

    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: text,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });

        const data = await response.json();

        if (!response.ok || !data.ok) {
            console.error('Telegram error:', data);
        } else {
            console.log('Telegram: wiadomość wysłana do grupy');
        }
    } catch (err) {
        console.error('Telegram error (network):', err.message);
    }
}

// ============================================
// AUTHENTICATION ENDPOINTS
// ============================================

function sendApprovalEmail(reservation, admin) {
    sendEmail(
        reservation.customerEmail,
        `Czarter potwierdzony - opiekun przydzielony (${reservation.id})`,
        `
            <h2>Czarter potwierdzony! ✅</h2>
            <p>To jest już <strong>ostateczne potwierdzenie</strong> — Twój czarter jest zorganizowany, opiekun został przydzielony.</p>
            <h3>Szczegóły rezerwacji:</h3>
            <ul>
                <li><strong>ID Rezerwacji:</strong> ${reservation.id}</li>
                <li><strong>Jacht:</strong> ${reservation.yacht.toUpperCase()}</li>
                <li><strong>Data:</strong> ${new Date(reservation.date).toLocaleDateString('pl-PL')}</li>
                <li><strong>Czas:</strong> ${reservation.startTime} (${reservation.hours}h)</li>
                <li><strong>Razem do zapłaty:</strong> ${reservation.totalPrice} zł</li>
                <li><strong>Kaucja zwrotna:</strong> 500 zł</li>
            </ul>
            <p style="background:#fff3cd;color:#856404;padding:10px;border-radius:6px;">⚠️ Prosimy o przygotowanie odliczonej kwoty kaucji w gotówce. Brak możliwości wniesienia opłaty kartą.</p>
            <h3>Dane opiekuna czarteru:</h3>
            <ul>
                <li><strong>Imię i nazwisko:</strong> ${admin.name}</li>
                <li><strong>Telefon:</strong> <a href="tel:${admin.phone}">${admin.phone}</a></li>
            </ul>
            <p>Pozdrawiamy,<br>YKP Lublin</p>
        `
    );
}

function sendUnservedApologyEmail(reservation) {
    sendEmail(
        reservation.customerEmail,
        `Rezerwacja anulowana - przepraszamy (${reservation.id})`,
        `
            <h2>Rezerwacja anulowana</h2>
            <p>Z przykrością informujemy, że Twoja rezerwacja czarteru nie mogła zostać zrealizowana <strong>z przyczyn niezależnych od klubu</strong> — nie udało się zapewnić opiekuna na ten termin.</p>
            <h3>Szczegóły anulowanej rezerwacji:</h3>
            <ul>
                <li><strong>ID Rezerwacji:</strong> ${reservation.id}</li>
                <li><strong>Jacht:</strong> ${reservation.yacht.toUpperCase()}</li>
                <li><strong>Data:</strong> ${new Date(reservation.date).toLocaleDateString('pl-PL')}</li>
                <li><strong>Czas:</strong> ${reservation.startTime} (${reservation.hours}h)</li>
            </ul>
            <p>Serdecznie przepraszamy za powstałe niedogodności i zachęcamy do złożenia nowej rezerwacji na inny termin.</p>
            <p>Pozdrawiamy,<br>YKP Lublin</p>
        `
    );
}

app.post('/api/auth/login', (req, res) => {
    const { password } = req.body;

    let role = null;
    if (password === ADMIN_PASSWORD) {
        role = 'admin';
    } else if (password === SKIPPER_PASSWORD) {
        role = 'skipper';
    }

    if (!role) {
        return res.status(401).json({ error: 'Błędne hasło' });
    }

    const token = jwt.sign(
        { role, timestamp: Date.now() },
        JWT_SECRET,
        { expiresIn: '24h' }
    );

    res.json({ token, role, message: 'Zalogowano pomyślnie' });
});

// ============================================
// RESERVATION ENDPOINTS
// ============================================

app.post('/api/reservations', async (req, res) => {
    const { yacht, date, startTime, hours, tackle, skipper, totalPrice, customerName, customerEmail, customerPhone } = req.body;

    if (!yacht || !date || !startTime || !hours || !customerName || !customerEmail) {
        return res.status(400).json({ error: 'Brakuje wymaganych pól' });
    }

    const parsedHours = parseInt(hours);

    // Klub potrzebuje minimum 36h na przygotowanie rezerwacji
    const noticeHours = hoursUntilReservation(date, startTime);
    if (noticeHours < MIN_HOURS_NOTICE) {
        return res.status(400).json({
            error: `Rezerwacje muszą być składane z minimum ${MIN_HOURS_NOTICE}-godzinnym wyprzedzeniem. Ten termin jest za wcześnie (klub potrzebuje czasu na przygotowanie).`
        });
    }

    // Sprawdzenie kolizji czasowej z istniejącymi rezerwacjami tego samego jachtu i dnia
    const { data: existingReservations, error: fetchErr } = await supabase
        .from('reservations')
        .select('start_time, hours')
        .eq('yacht', yacht)
        .eq('date', date)
        .in('status', ['pending', 'approved']);

    if (fetchErr) {
        console.error('Supabase select error:', fetchErr);
        return res.status(500).json({ error: 'Błąd sprawdzania dostępności terminu' });
    }

    const newStartMinutes = timeToMinutes(startTime);
    const newEndMinutes = newStartMinutes + parsedHours * 60;
    const collision = findCollision(newStartMinutes, newEndMinutes, existingReservations);

    if (collision) {
        const suggestedStartTime = findEarliestAvailableSlot(parsedHours, existingReservations);

        if (suggestedStartTime) {
            return res.status(409).json({
                error: 'Wybrany termin koliduje z inną rezerwacją tego jachtu.',
                suggestedStartTime
            });
        } else {
            return res.status(409).json({
                error: 'Wybrany termin koliduje z inną rezerwacją tego jachtu, a tego dnia nie ma już wolnego okna na czarter o tej długości (godziny pracy: 10:00-20:00).',
                suggestedStartTime: null
            });
        }
    }

    const id = 'RES-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    // Omega ma obowiązkowe taklowanie - wymuszone tutaj niezależnie od tego, co przesłał klient
    const enforcedTackle = enforceMandatoryTackle(yacht, tackle);
    const enforcedSkipper = Boolean(skipper);

    // Cena i podział przychodu liczone spójnie po stronie serwera na podstawie wymuszonych wartości
    // (nie ufamy total_price przesłanemu przez klienta - mogłoby nie uwzględniać obowiązkowego taklowania)
    const computedTotalPrice = calculateTotalPrice(yacht, parsedHours, enforcedTackle, enforcedSkipper);
    const { clubRevenue, skipperRevenue } = calculateRevenueSplit(yacht, parsedHours, enforcedTackle, enforcedSkipper);

    const { data, error } = await supabase
        .from('reservations')
        .insert({
            id,
            yacht,
            date,
            start_time: startTime,
            hours: parsedHours,
            tackle: enforcedTackle,
            skipper: enforcedSkipper,
            total_price: computedTotalPrice,
            club_revenue: clubRevenue,
            skipper_revenue: skipperRevenue,
            customer_name: customerName,
            customer_email: customerEmail,
            customer_phone: customerPhone,
            status: 'pending'
        })
        .select()
        .single();

    if (error) {
        console.error('Supabase insert error:', error);
        return res.status(500).json({ error: 'Błąd zapisu rezerwacji w bazie danych' });
    }

    const reservation = mapReservation(data);

    sendEmail(
        reservation.customerEmail,
        `Zgłoszenie rezerwacji przyjęte - ${reservation.id}`,
        `
            <h2>Zgłoszenie rezerwacji przyjęte</h2>
            <p>Dziękujemy za zgłoszenie! To jeszcze <strong>nie jest ostateczne potwierdzenie czarteru</strong> — Twoje zgłoszenie czeka teraz na przydzielenie opiekuna przez klub.</p>
            <p>Gdy tylko opiekun zostanie przypisany, dostaniesz <strong>kolejnego e-maila</strong> z ostatecznym potwierdzeniem oraz danymi kontaktowymi opiekuna.</p>
            <h3>Szczegóły zgłoszenia:</h3>
            <ul>
                <li><strong>ID Rezerwacji:</strong> ${reservation.id}</li>
                <li><strong>Jacht:</strong> ${reservation.yacht.toUpperCase()}</li>
                <li><strong>Data:</strong> ${new Date(reservation.date).toLocaleDateString('pl-PL')}</li>
                <li><strong>Czas:</strong> ${reservation.startTime} (${reservation.hours}h)</li>
                <li><strong>Razem do zapłaty:</strong> ${reservation.totalPrice} zł</li>
                <li><strong>Kaucja zwrotna:</strong> 500 zł</li>
            </ul>
            <p style="background:#fff3cd;color:#856404;padding:10px;border-radius:6px;">⚠️ Prosimy o przygotowanie odliczonej kwoty kaucji w gotówce. Brak możliwości wniesienia opłaty kartą.</p>
            <p>📌 Status zgłoszenia: <strong>Oczekuje na przydzielenie opiekuna</strong></p>
            <p>Pozdrawiamy,<br>YKP Lublin</p>
        `
    );

    const { data: allAdmins } = await supabase.from('admins').select('email');
    const adminEmails = (allAdmins || []).map(a => a.email).filter(e => e && !e.endsWith('@club.local'));
    adminEmails.forEach(email => {
        sendEmail(
            email,
            `Nowa rezerwacja - ${reservation.id}`,
            `
                <h2>Nowa Rezerwacja Czarteru</h2>
                <ul>
                    <li><strong>ID:</strong> ${reservation.id}</li>
                    <li><strong>Jacht:</strong> ${reservation.yacht.toUpperCase()}</li>
                    <li><strong>Data:</strong> ${new Date(reservation.date).toLocaleDateString('pl-PL')}</li>
                    <li><strong>Czas:</strong> ${reservation.startTime} (${reservation.hours}h)</li>
                </ul>
                <h3>Klient:</h3>
                <ul>
                    <li><strong>Imię:</strong> ${reservation.customerName}</li>
                    <li><strong>Email:</strong> ${reservation.customerEmail}</li>
                    <li><strong>Telefon:</strong> ${reservation.customerPhone}</li>
                </ul>
            `
        );
    });

    const extrasParts = [];
    if (reservation.tackle) extrasParts.push('taklowanie');
    if (reservation.skipper) extrasParts.push('asysta skippera');
    const extrasText = extrasParts.length > 0 ? ` (${extrasParts.join(' + ')})` : '';
    const dateLabel = new Date(reservation.date).toLocaleDateString('pl-PL');
    const panelUrl = `${APP_BASE_URL}/#admin`;

    sendTelegramMessage(
        `⛵ <b>Nowa rezerwacja czeka na zatwierdzenie</b>\n\n` +
        `Jacht: <b>${reservation.yacht.toUpperCase()}</b>\n` +
        `Data: <b>${dateLabel}</b>, godz. <b>${reservation.startTime}</b> (${reservation.hours}h)${extrasText}\n` +
        `Klient: ${reservation.customerName}, tel. ${reservation.customerPhone || 'brak'}\n\n` +
        `👉 <a href="${panelUrl}">Otwórz Panel Klubowy</a>`
    );

    res.status(201).json({ message: 'Rezerwacja utworzona', reservation });
});

// Generator serii sesji kursu (np. na stopień żeglarza jachtowego) - dostępny WYŁĄCZNIE
// z panelu klubowego. Tworzy jedną rezerwację na każdy pasujący dzień tygodnia w podanym
// zakresie dat, zawsze bezpłatną, ze statusem "pending" (instruktor przydzielany później,
// osobno do każdej sesji - tym samym mechanizmem co przy zwykłych czarterach).
// Terminy kolidujące z istniejącymi rezerwacjami są pomijane, nie przerywają całej serii.
app.post('/api/reservations/course-batch', verifyAdminToken, async (req, res) => {
    const { yacht, startDate, endDate, daysOfWeek, startTime, hours, courseName } = req.body;

    if (!yacht || !startDate || !endDate || !Array.isArray(daysOfWeek) || daysOfWeek.length === 0
        || !startTime || !hours || !courseName || !courseName.trim()) {
        return res.status(400).json({ error: 'Brakuje wymaganych pól (jacht, zakres dat, dni tygodnia, godzina, liczba godzin, nazwa kursu)' });
    }

    if (startDate > endDate) {
        return res.status(400).json({ error: 'Data końcowa musi być późniejsza niż data początkowa' });
    }

    const parsedHours = parseInt(hours);
    const weekdays = daysOfWeek.map(Number); // 0=niedziela ... 6=sobota (konwencja JS Date.getUTCDay())

    // Wyliczenie wszystkich pasujących dat w zakresie - operacje wyłącznie na liczbach
    // w UTC, żeby uniknąć błędów przesunięcia daty znanych z wcześniejszych problemów
    // ze strefą czasową w tym projekcie.
    const parseYMD = (str) => {
        const [y, m, d] = str.split('-').map(Number);
        return { y, m, d };
    };
    const start = parseYMD(startDate);
    const end = parseYMD(endDate);
    const endMs = Date.UTC(end.y, end.m - 1, end.d);

    if (endMs - Date.UTC(start.y, start.m - 1, start.d) > 366 * 24 * 60 * 60 * 1000) {
        return res.status(400).json({ error: 'Zakres dat jest zbyt długi (maksymalnie 366 dni) - sprawdź czy nie ma pomyłki w dacie' });
    }

    const candidateDates = [];
    let cursor = Date.UTC(start.y, start.m - 1, start.d);
    while (cursor <= endMs) {
        const d = new Date(cursor);
        if (weekdays.includes(d.getUTCDay())) {
            const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
            candidateDates.push(dateStr);
        }
        cursor += 24 * 60 * 60 * 1000;
    }

    if (candidateDates.length === 0) {
        return res.status(400).json({ error: 'Wybrany zakres dat i dni tygodnia nie dają ani jednego terminu' });
    }

    // Pobranie WSZYSTKICH istniejących rezerwacji tego jachtu w całym zakresie za jednym razem
    // (zamiast osobnego zapytania na każdą kandydującą datę) - sprawdzanie kolizji odbywa się
    // dalej w pamięci procesu.
    const { data: existingReservations, error: fetchErr } = await supabase
        .from('reservations')
        .select('date, start_time, hours, customer_name')
        .eq('yacht', yacht)
        .gte('date', startDate)
        .lte('date', endDate)
        .in('status', ['pending', 'approved']);

    if (fetchErr) {
        console.error('Supabase select error:', fetchErr);
        return res.status(500).json({ error: 'Błąd sprawdzania dostępności terminów' });
    }

    const newStartMinutes = timeToMinutes(startTime);
    const newEndMinutes = newStartMinutes + parsedHours * 60;
    const enforcedTackle = enforceMandatoryTackle(yacht, false);

    const toInsert = [];
    const skipped = [];

    candidateDates.forEach((dateStr, i) => {
        const dayReservations = existingReservations.filter(r => r.date === dateStr);
        const collision = findCollision(newStartMinutes, newEndMinutes, dayReservations);

        if (collision) {
            const collisionEnd = minutesToTime(timeToMinutes(collision.start_time) + collision.hours * 60);
            skipped.push({
                date: dateStr,
                reason: `koliduje z "${collision.customer_name}" (${collision.start_time}-${collisionEnd})`
            });
        } else {
            toInsert.push({
                id: 'RES-' + Date.now() + '-' + i + '-' + Math.random().toString(36).substr(2, 6),
                yacht,
                date: dateStr,
                start_time: startTime,
                hours: parsedHours,
                tackle: enforcedTackle,
                skipper: false,
                total_price: 0,
                club_revenue: 0,
                skipper_revenue: 0,
                customer_name: `Kurs: ${courseName.trim()}`,
                customer_email: 'kurs@wewnetrzna.local',
                customer_phone: null,
                status: 'pending',
                is_course_session: true
            });
        }
    });

    let inserted = [];
    if (toInsert.length > 0) {
        const { data, error } = await supabase
            .from('reservations')
            .insert(toInsert)
            .select();

        if (error) {
            console.error('Supabase insert error:', error);
            return res.status(500).json({ error: 'Błąd zapisu sesji kursu' });
        }
        inserted = data;
    }

    res.status(201).json({
        message: `Utworzono ${inserted.length} sesji kursu${skipped.length > 0 ? `, pominięto ${skipped.length} (kolizje)` : ''}`,
        createdCount: inserted.length,
        skipped
    });
});

// Rezerwacja "własna klubu" (np. przegląd techniczny, rejs integracyjny) - dostępna
// WYŁĄCZNIE z panelu klubowego (verifyAdminToken). Bez ceny/kosztu, nie wlicza się
// do puli obsłużonych czarterów opiekunów w raporcie miesięcznym, i nie wysyła
// żadnych e-maili (nie ma prawdziwego klienta).
app.post('/api/reservations/club', verifyAdminToken, async (req, res) => {
    const { yacht, date, startTime, hours, purpose } = req.body;

    if (!yacht || !date || !startTime || !hours || !purpose || !purpose.trim()) {
        return res.status(400).json({ error: 'Brakuje wymaganych pól (jacht, data, godzina, liczba godzin, cel rezerwacji)' });
    }

    const parsedHours = parseInt(hours);

    // Ta sama walidacja kolizji co przy zwykłej rezerwacji - klub też nie może
    // zarezerwować jachtu zajętego przez płacącego klienta.
    const { data: existingReservations, error: fetchErr } = await supabase
        .from('reservations')
        .select('start_time, hours')
        .eq('yacht', yacht)
        .eq('date', date)
        .in('status', ['pending', 'approved']);

    if (fetchErr) {
        console.error('Supabase select error:', fetchErr);
        return res.status(500).json({ error: 'Błąd sprawdzania dostępności terminu' });
    }

    const newStartMinutes = timeToMinutes(startTime);
    const newEndMinutes = newStartMinutes + parsedHours * 60;
    const collision = findCollision(newStartMinutes, newEndMinutes, existingReservations);

    if (collision) {
        const suggestedStartTime = findEarliestAvailableSlot(parsedHours, existingReservations);
        return res.status(409).json({
            error: 'Wybrany termin koliduje z inną rezerwacją tego jachtu.',
            suggestedStartTime: suggestedStartTime || null
        });
    }

    const id = 'RES-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    // Dla spójności danych historycznych - Omega zawsze ma taklowanie, nawet w rezerwacji
    // klubowej (cena i tak zawsze wynosi 0 zł, to tylko poprawny zapis faktycznego stanu).
    const enforcedTackle = enforceMandatoryTackle(yacht, false);

    const { data, error } = await supabase
        .from('reservations')
        .insert({
            id,
            yacht,
            date,
            start_time: startTime,
            hours: parsedHours,
            tackle: enforcedTackle,
            skipper: false,
            total_price: 0,
            club_revenue: 0,
            skipper_revenue: 0,
            customer_name: `Rezerwacja klubowa: ${purpose.trim()}`,
            customer_email: 'klub@wewnetrzna.local',
            customer_phone: null,
            status: 'approved',
            is_club_reservation: true
        })
        .select('*, admin:admins(id, name, phone, email)')
        .single();

    if (error) {
        console.error('Supabase insert error:', error);
        return res.status(500).json({ error: 'Błąd zapisu rezerwacji klubowej' });
    }

    res.status(201).json({ message: 'Rezerwacja klubowa utworzona', reservation: mapReservation(data) });
});

app.get('/api/reservations', verifyAdminToken, async (req, res) => {
    const { data, error } = await supabase
        .from('reservations')
        .select('*, admin:admins(id, name, phone, email)')
        .order('date', { ascending: true });

    if (error) {
        console.error('Supabase select error:', error);
        return res.status(500).json({ error: 'Błąd pobierania rezerwacji' });
    }

    res.json(data.map(mapReservation));
});

// Publiczny widok rezerwacji - bez logowania, dla klientów wybierających termin.
// Celowo pobiera z bazy WYŁĄCZNIE pola niezawierające danych osobowych - żadnych
// customer_name/email/phone. To nie jest tylko "ukrycie" tych pól w odpowiedzi,
// tylko w ogóle ich nie pobieramy z bazy, więc nie ma ryzyka przypadkowego wycieku.
app.get('/api/reservations/public', async (req, res) => {
    const { data, error } = await supabase
        .from('reservations')
        .select('yacht, date, start_time, hours, status')
        .in('status', ['pending', 'approved'])
        .order('date', { ascending: true });

    if (error) {
        console.error('Supabase select error:', error);
        return res.status(500).json({ error: 'Błąd pobierania dostępności' });
    }

    res.json(data.map(r => ({
        yacht: r.yacht,
        date: r.date,
        startTime: r.start_time,
        hours: r.hours,
        status: r.status
    })));
});

app.get('/api/reservations/:id', async (req, res) => {
    const { data, error } = await supabase
        .from('reservations')
        .select('*, admin:admins(id, name, phone, email)')
        .eq('id', req.params.id)
        .maybeSingle();

    if (error || !data) {
        return res.status(404).json({ error: 'Rezerwacja nie znaleziona' });
    }

    res.json(mapReservation(data));
});

app.patch('/api/reservations/:id', verifyAdminToken, async (req, res) => {
    const { status, adminId, customerName, customerEmail, customerPhone, yacht, date, startTime, hours } = req.body;
    const updates = {};
    let assignedAdmin = null;

    // Pobierz obecny stan rezerwacji - potrzebny do uzupełnienia niezmienianych pól
    // (np. tackle/skipper przy przeliczaniu ceny) oraz do wykluczenia jej z porównania kolizji
    const { data: currentRes, error: currentErr } = await supabase
        .from('reservations')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();

    if (currentErr || !currentRes) {
        return res.status(404).json({ error: 'Rezerwacja nie znaleziona' });
    }

    if (status) {
        updates.status = status;
    }

    if (customerName !== undefined) {
        if (!customerName.trim()) return res.status(400).json({ error: 'Imię i nazwisko nie może być puste' });
        updates.customer_name = customerName.trim();
    }
    if (customerEmail !== undefined) {
        if (!customerEmail.trim()) return res.status(400).json({ error: 'Email nie może być pusty' });
        updates.customer_email = customerEmail.trim();
    }
    if (customerPhone !== undefined) updates.customer_phone = customerPhone.trim();

    // Edycja jachtu/daty/godziny/długości - wymaga ponownego sprawdzenia kolizji
    const changingSchedule = yacht !== undefined || date !== undefined || startTime !== undefined || hours !== undefined;

    if (changingSchedule) {
        const effectiveYacht = yacht !== undefined ? yacht : currentRes.yacht;
        const effectiveDate = date !== undefined ? date : currentRes.date;
        const effectiveStartTime = startTime !== undefined ? startTime : currentRes.start_time;
        const effectiveHours = hours !== undefined ? parseInt(hours) : currentRes.hours;

        const newStartMinutes = timeToMinutes(effectiveStartTime);
        const newEndMinutes = newStartMinutes + effectiveHours * 60;

        const { data: existingOnYacht, error: existErr } = await supabase
            .from('reservations')
            .select('id, start_time, hours, customer_name')
            .eq('yacht', effectiveYacht)
            .eq('date', effectiveDate)
            .in('status', ['pending', 'approved'])
            .neq('id', req.params.id);

        if (existErr) {
            console.error('Supabase select error:', existErr);
            return res.status(500).json({ error: 'Błąd sprawdzania dostępności terminu' });
        }

        const collision = findCollision(newStartMinutes, newEndMinutes, existingOnYacht);

        if (collision) {
            const collisionEnd = minutesToTime(timeToMinutes(collision.start_time) + collision.hours * 60);
            const altYacht = INTERCHANGEABLE_YACHT[effectiveYacht];

            if (altYacht) {
                const { data: existingOnAlt, error: altErr } = await supabase
                    .from('reservations')
                    .select('id, start_time, hours')
                    .eq('yacht', altYacht)
                    .eq('date', effectiveDate)
                    .in('status', ['pending', 'approved'])
                    .neq('id', req.params.id);

                if (!altErr) {
                    const altCollision = findCollision(newStartMinutes, newEndMinutes, existingOnAlt);
                    if (!altCollision) {
                        return res.status(409).json({
                            error: `Kolizja z rezerwacją "${collision.customer_name}" (${collision.start_time}-${collisionEnd}) na jachcie ${effectiveYacht.toUpperCase()}.`,
                            suggestedYacht: altYacht
                        });
                    }
                }
            }

            return res.status(409).json({
                error: `Kolizja z rezerwacją "${collision.customer_name}" (${collision.start_time}-${collisionEnd}) na jachcie ${effectiveYacht.toUpperCase()}.`,
                suggestedYacht: null
            });
        }

        updates.yacht = effectiveYacht;
        updates.date = effectiveDate;
        updates.start_time = effectiveStartTime;
        updates.hours = effectiveHours;

        // Omega ma obowiązkowe taklowanie - wymuszone również przy edycji istniejącej
        // rezerwacji (np. gdy admin zmienia jacht na Omegę, a taklowania wcześniej nie było)
        const enforcedTackle = enforceMandatoryTackle(effectiveYacht, currentRes.tackle);
        updates.tackle = enforcedTackle;

        // Rezerwacje klubowe i sesje kursu są zawsze bezpłatne - zmiana godzin/jachtu
        // NIE MOŻE ich "uaktywnić" jako płatnych. Cena liczona normalnie tylko dla
        // zwykłych, płatnych czarterów.
        const isFreeCategory = currentRes.is_club_reservation || currentRes.is_course_session;
        if (isFreeCategory) {
            updates.total_price = 0;
            updates.club_revenue = 0;
            updates.skipper_revenue = 0;
        } else {
            updates.total_price = calculateTotalPrice(effectiveYacht, effectiveHours, enforcedTackle, currentRes.skipper);
            const revenueSplit = calculateRevenueSplit(effectiveYacht, effectiveHours, enforcedTackle, currentRes.skipper);
            updates.club_revenue = revenueSplit.clubRevenue;
            updates.skipper_revenue = revenueSplit.skipperRevenue;
        }
    }

    if (adminId) {
        const { data: adminRow, error: adminErr } = await supabase
            .from('admins')
            .select('*')
            .eq('id', adminId)
            .maybeSingle();

        if (adminErr || !adminRow) {
            return res.status(404).json({ error: 'Opiekun nie znaleziony' });
        }

        updates.admin_id = adminId;
        updates.status = 'approved';
        assignedAdmin = adminRow;
    }

    const { data, error } = await supabase
        .from('reservations')
        .update(updates)
        .eq('id', req.params.id)
        .select('*, admin:admins(id, name, phone, email)')
        .maybeSingle();

    if (error || !data) {
        return res.status(404).json({ error: 'Rezerwacja nie znaleziona' });
    }

    const reservation = mapReservation(data);

    if (assignedAdmin && !reservation.isClubReservation && !reservation.isCourseSession) {
        sendApprovalEmail(reservation, assignedAdmin);
    }

    res.json({ message: 'Rezerwacja zaktualizowana', reservation });
});

app.delete('/api/reservations/:id', verifyAdminToken, async (req, res) => {
    const { data, error: fetchErr } = await supabase
        .from('reservations')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();

    if (fetchErr || !data) {
        return res.status(404).json({ error: 'Rezerwacja nie znaleziona' });
    }

    const { error: delErr } = await supabase
        .from('reservations')
        .delete()
        .eq('id', req.params.id);

    if (delErr) {
        console.error('Supabase delete error:', delErr);
        return res.status(500).json({ error: 'Błąd usuwania rezerwacji' });
    }

    const reservation = mapReservation(data);

    if (!reservation.isClubReservation && !reservation.isCourseSession) {
        sendEmail(
            reservation.customerEmail,
            `Anulowanie rezerwacji - ${reservation.id}`,
            `
                <h2>Rezerwacja Anulowana</h2>
                <p>Rezerwacja czarteru jachtu ${reservation.yacht.toUpperCase()} na dzień ${new Date(reservation.date).toLocaleDateString('pl-PL')} została anulowana.</p>
            `
        );
    }

    res.json({ message: 'Rezerwacja anulowana' });
});

// ============================================
// ADMIN (SKIPPER) ENDPOINTS
// ============================================

app.get('/api/admins', verifyAnyToken, async (req, res) => {
    const { data, error } = await supabase.from('admins').select('*').order('id', { ascending: true });

    if (error) {
        console.error('Supabase select error:', error);
        return res.status(500).json({ error: 'Błąd pobierania opiekunów' });
    }

    res.json(data);
});

app.post('/api/admins', verifyAdminToken, async (req, res) => {
    const { name, phone, email } = req.body;

    if (!name || !phone) {
        return res.status(400).json({ error: 'Brakuje wymaganych pól' });
    }

    const { data, error } = await supabase
        .from('admins')
        .insert({ name, phone, email: email || '' })
        .select()
        .single();

    if (error) {
        console.error('Supabase insert error:', error);
        return res.status(500).json({ error: 'Błąd dodawania opiekuna' });
    }

    res.status(201).json({ message: 'Opiekun dodany', admin: data });
});

app.patch('/api/admins/:id', verifyAdminToken, async (req, res) => {
    const { name, phone, email } = req.body;
    const updates = {};

    if (name) updates.name = name;
    if (phone) updates.phone = phone;
    if (email !== undefined) updates.email = email;

    const { data, error } = await supabase
        .from('admins')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .maybeSingle();

    if (error || !data) {
        return res.status(404).json({ error: 'Opiekun nie znaleziony' });
    }

    res.json({ message: 'Opiekun zaktualizowany', admin: data });
});

app.delete('/api/admins/:id', verifyAdminToken, async (req, res) => {
    const { error } = await supabase.from('admins').delete().eq('id', req.params.id);

    if (error) {
        console.error('Supabase delete error:', error);
        return res.status(500).json({ error: 'Błąd usuwania opiekuna' });
    }

    res.json({ message: 'Opiekun usunięty' });
});

// ============================================
// UNAVAILABILITY ENDPOINTS (niedostępność opiekunów)
// ============================================

app.get('/api/unavailability', verifyAnyToken, async (req, res) => {
    const { data, error } = await supabase.from('unavailability').select('*');

    if (error) {
        console.error('Supabase select error:', error);
        return res.status(500).json({ error: 'Błąd pobierania danych' });
    }

    res.json(data.map(mapUnavailability));
});

app.post('/api/unavailability', verifyAnyToken, async (req, res) => {
    const { adminId, date } = req.body;

    if (!adminId || !date) {
        return res.status(400).json({ error: 'Brakuje wymaganych pól' });
    }

    const { data: existing } = await supabase
        .from('unavailability')
        .select('*')
        .eq('admin_id', adminId)
        .eq('date', date)
        .maybeSingle();

    if (existing) {
        return res.status(200).json({ message: 'Już oznaczone', entry: mapUnavailability(existing) });
    }

    const { data, error } = await supabase
        .from('unavailability')
        .insert({ admin_id: adminId, date })
        .select()
        .single();

    if (error) {
        console.error('Supabase insert error:', error);
        return res.status(500).json({ error: 'Błąd zapisu' });
    }

    res.status(201).json({ message: 'Dzień oznaczony jako niedostępny', entry: mapUnavailability(data) });
});

app.delete('/api/unavailability/:id', verifyAnyToken, async (req, res) => {
    const { error } = await supabase.from('unavailability').delete().eq('id', req.params.id);

    if (error) {
        console.error('Supabase delete error:', error);
        return res.status(500).json({ error: 'Błąd usuwania wpisu' });
    }

    res.json({ message: 'Wpis usunięty' });
});

// ============================================
// RAPORT MIESIĘCZNY (PDF) - przychód klubu i opiekunów
// ============================================

const FONT_REGULAR = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');
const MONTH_NAMES_PL = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'];
const YACHT_LABELS = { enn: 'Enn', first: 'First', omega: 'Omega' };

app.get('/api/reports/monthly', verifyAdminToken, async (req, res) => {
    const { month } = req.query; // oczekiwany format: "2026-07"

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'Nieprawidłowy format miesiąca (oczekiwano YYYY-MM)' });
    }

    const [yearStr, monthStr] = month.split('-');
    const year = parseInt(yearStr);
    const monthNum = parseInt(monthStr);

    if (monthNum < 1 || monthNum > 12) {
        return res.status(400).json({ error: 'Nieprawidłowy numer miesiąca' });
    }

    const startDate = `${month}-01`;
    const lastDay = new Date(year, monthNum, 0).getDate();
    const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

    const { data: reservations, error } = await supabase
        .from('reservations')
        .select('yacht, club_revenue, admin:admins(id, name)')
        .eq('status', 'approved')
        .eq('is_club_reservation', false)
        .eq('is_course_session', false)
        .gte('date', startDate)
        .lte('date', endDate);

    if (error) {
        console.error('Supabase select error:', error);
        return res.status(500).json({ error: 'Błąd pobierania danych do raportu' });
    }

    // Rezerwacje nieobsłużone (brak opiekuna 24h przed startem) w tym samym okresie
    const { data: unservedReservations, error: unservedErr } = await supabase
        .from('reservations')
        .select('yacht, date, start_time, customer_name')
        .eq('status', 'unserved')
        .eq('is_club_reservation', false)
        .eq('is_course_session', false)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: true });

    if (unservedErr) {
        console.error('Supabase select error:', unservedErr);
        return res.status(500).json({ error: 'Błąd pobierania danych o rezerwacjach nieobsłużonych' });
    }

    // Agregacja: przychód klubu wg jachtu
    const byYacht = { enn: 0, first: 0, omega: 0 };
    let totalClub = 0;

    // Agregacja: liczba obsłużonych czarterów wg opiekuna
    // (opiekunowie nie otrzymują od klubu gratyfikacji pieniężnej za taklowanie/asystę -
    // te opłaty trafiają do nich bezpośrednio od klienta i nie są istotne z punktu widzenia
    // księgowości klubu; liczy się tu wyłącznie liczba obsłużonych czarterów, jako wkład
    // do puli godzin przepracowanych dla klubu)
    const byAdminCount = {};
    let totalHandledCharters = 0;

    reservations.forEach(r => {
        byYacht[r.yacht] = (byYacht[r.yacht] || 0) + (r.club_revenue || 0);
        totalClub += (r.club_revenue || 0);

        if (r.admin) {
            const name = r.admin.name;
            byAdminCount[name] = (byAdminCount[name] || 0) + 1;
            totalHandledCharters += 1;
        }
    });

    const monthLabel = `${MONTH_NAMES_PL[monthNum - 1]} ${year}`;

    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="raport-${month}.pdf"`);
    doc.pipe(res);

    // Nagłówek
    doc.font(FONT_BOLD).fontSize(20).text('Yacht Klub Lublin', { align: 'center' });
    doc.font(FONT_REGULAR).fontSize(15).text(`Raport miesięczny — ${monthLabel}`, { align: 'center' });
    doc.moveDown(2);

    // Sekcja: przychód klubu wg jachtu
    doc.font(FONT_BOLD).fontSize(14).text('Przychód klubu wg jachtu');
    doc.moveDown(0.5);
    doc.font(FONT_REGULAR).fontSize(12);
    ['enn', 'first', 'omega'].forEach(y => {
        doc.text(`${YACHT_LABELS[y]}:  ${byYacht[y]} zł`);
    });
    doc.moveDown(0.3);
    doc.font(FONT_BOLD).fontSize(13).text(`RAZEM KLUB:  ${totalClub} zł`);
    doc.moveDown(2);

    // Sekcja: liczba obsłużonych czarterów wg opiekuna
    doc.font(FONT_BOLD).fontSize(14).text('Liczba obsłużonych czarterów wg opiekuna');
    doc.moveDown(0.3);
    doc.font(FONT_REGULAR).fontSize(9).fillColor('#888888')
        .text('(wkład do puli godzin przepracowanych dla klubu - opiekunowie nie otrzymują od klubu gratyfikacji pieniężnej za taklowanie/asystę)');
    doc.fillColor('#000000');
    doc.moveDown(0.5);
    doc.font(FONT_REGULAR).fontSize(12);

    const adminEntries = Object.entries(byAdminCount).sort((a, b) => b[1] - a[1]);
    if (adminEntries.length === 0) {
        doc.text('Brak obsłużonych czarterów w tym miesiącu.');
    } else {
        adminEntries.forEach(([name, count]) => {
            const label = count === 1 ? 'czarter' : 'czartery(-ów)';
            doc.text(`${name}:  ${count} ${label}`);
        });
    }
    doc.moveDown(0.3);
    doc.font(FONT_BOLD).fontSize(13).text(`RAZEM OBSŁUŻONYCH CZARTERÓW:  ${totalHandledCharters}`);
    doc.moveDown(2);

    // Sekcja: rezerwacje nieobsłużone (brak opiekuna 24h przed startem)
    doc.font(FONT_BOLD).fontSize(14).text('Rezerwacje nieobsłużone');
    doc.moveDown(0.3);
    doc.font(FONT_REGULAR).fontSize(9).fillColor('#888888')
        .text('(brak przydzielonego opiekuna na 24h przed rozpoczęciem - klient został automatycznie poinformowany mailem)');
    doc.fillColor('#000000');
    doc.moveDown(0.5);
    doc.font(FONT_REGULAR).fontSize(12);

    if (unservedReservations.length === 0) {
        doc.text('Brak nieobsłużonych rezerwacji w tym miesiącu.');
    } else {
        unservedReservations.forEach(r => {
            const dateLabel = new Date(r.date).toLocaleDateString('pl-PL');
            doc.text(`${dateLabel} ${r.start_time} — ${YACHT_LABELS[r.yacht]} — ${r.customer_name}`);
        });
    }
    doc.moveDown(0.3);
    doc.font(FONT_BOLD).fontSize(13).text(`RAZEM NIEOBSŁUŻONYCH:  ${unservedReservations.length}`);
    doc.moveDown(3);

    // Stopka
    doc.font(FONT_REGULAR).fontSize(9).fillColor('#888888')
        .text(`Wygenerowano automatycznie: ${new Date().toLocaleString('pl-PL')}`, { align: 'center' });

    doc.end();
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
    res.json({ status: 'OK' });
});

// Catch-all: SPA fallback dla dowolnej innej trasy GET
app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Wewnętrzny błąd serwera' });
});

// ============================================
// CODZIENNE PODSUMOWANIE NA TELEGRAM (o 8:00 czasu polskiego)
// ============================================

async function sendDailyReservationsDigest() {
    // Uruchamiane dokładnie o 8:00 czasu polskiego (patrz harmonogram cron niżej),
    // więc data UTC w tym momencie zawsze pokrywa się z datą kalendarzową w Polsce
    // (Polska to UTC+1/+2, więc 8:00 czasu polskiego to 6:00-7:00 UTC tego samego dnia -
    // nie ma ryzyka "przeskoczenia" na inny dzień przy tej konkretnej porze).
    const today = new Date().toISOString().split('T')[0];

    try {
        const { data: todaysReservations, error } = await supabase
            .from('reservations')
            .select('yacht, start_time, hours, tackle, skipper, customer_name, is_club_reservation, admin:admins(name)')
            .eq('date', today)
            .in('status', ['pending', 'approved'])
            .order('start_time', { ascending: true });

        if (error) {
            console.error('Codzienne podsumowanie - błąd pobierania danych:', error);
            return;
        }

        if (!todaysReservations || todaysReservations.length === 0) {
            console.log('Codzienne podsumowanie: brak rezerwacji na dziś, nic nie wysyłam');
            return; // brak czarterów - zgodnie z założeniem, nic się nie dzieje
        }

        const dateLabel = new Date(today).toLocaleDateString('pl-PL');
        const lines = todaysReservations.map(r => {
            const extrasParts = [];
            if (r.tackle) extrasParts.push('taklowanie');
            if (r.skipper) extrasParts.push('asysta skippera');
            const extrasText = extrasParts.length > 0 ? ` (${extrasParts.join(' + ')})` : '';
            const endTime = minutesToTime(timeToMinutes(r.start_time) + r.hours * 60);

            if (r.is_club_reservation) {
                return `🏛️ <b>${r.yacht.toUpperCase()}</b> ${r.start_time}-${endTime} — rezerwacja klubowa (${r.customer_name.replace('Rezerwacja klubowa: ', '')})`;
            }

            const adminText = r.admin ? `, opiekun: ${r.admin.name}` : ', opiekun: BRAK ⚠️';
            return `⛵ <b>${r.yacht.toUpperCase()}</b> ${r.start_time}-${endTime}${extrasText} — ${r.customer_name}${adminText}`;
        });

        const message = `☀️ <b>Rezerwacje na dziś (${dateLabel})</b>\n\n${lines.join('\n')}`;

        await sendTelegramMessage(message);
        console.log(`Codzienne podsumowanie: wysłano (${todaysReservations.length} rezerwacji)`);
    } catch (err) {
        console.error('Codzienne podsumowanie - nieoczekiwany błąd:', err.message);
    }
}

// Harmonogram: codziennie o 8:00 czasu polskiego (strefa uwzględnia automatycznie
// zmianę czasu zima/lato, w przeciwieństwie do stałego przesunięcia UTC).
cron.schedule('0 8 * * *', sendDailyReservationsDigest, { timezone: 'Europe/Warsaw' });

// ============================================
// AUTOMATYCZNE OZNACZANIE REZERWACJI NIEOBSŁUŻONYCH
// ============================================
// Rezerwacje oczekujące (pending), którym NIE przydzielono opiekuna, a do startu zostało
// mniej niż 24h, są automatycznie oznaczane statusem "unserved" (nieobsłużona).
// Rekord NIE jest kasowany - zostaje w bazie i pojawia się w raporcie jako osobna
// kategoria. Klient dostaje maila z przeprosinami (pomijane dla rezerwacji klubowych
// i sesji kursu - tam nie ma prawdziwego adresu klienta).

async function processUnservedReservations() {
    try {
        // Bezpieczny, przybliżony filtr zakresu dat na poziomie zapytania do bazy (żeby nie
        // skanować całej przyszłej tabeli co godzinę) - dokładne sprawdzenie "czy to mniej
        // niż 24h" odbywa się dalej, osobno dla każdego kandydata.
        const now = getWarsawNowParts();
        const todayMs = Date.UTC(now.y, now.m - 1, now.d);
        const cutoff = new Date(todayMs + 2 * 24 * 60 * 60 * 1000);
        const cutoffDateStr = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}-${String(cutoff.getUTCDate()).padStart(2, '0')}`;

        const { data: candidates, error } = await supabase
            .from('reservations')
            .select('*')
            .eq('status', 'pending')
            .is('admin_id', null)
            .lte('date', cutoffDateStr);

        if (error) {
            console.error('Przetwarzanie nieobsłużonych - błąd pobierania danych:', error);
            return;
        }

        if (!candidates || candidates.length === 0) return;

        for (const row of candidates) {
            const hoursLeft = hoursUntilReservation(row.date, row.start_time);
            if (hoursLeft >= 24) continue;

            const { error: updateErr } = await supabase
                .from('reservations')
                .update({ status: 'unserved' })
                .eq('id', row.id);

            if (updateErr) {
                console.error(`Błąd oznaczania rezerwacji ${row.id} jako nieobsłużonej:`, updateErr);
                continue;
            }

            console.log(`Rezerwacja ${row.id} oznaczona jako nieobsłużona (${hoursLeft.toFixed(1)}h do startu, brak opiekuna)`);

            if (!row.is_club_reservation && !row.is_course_session) {
                sendUnservedApologyEmail(mapReservation(row));
            }
        }
    } catch (err) {
        console.error('Przetwarzanie nieobsłużonych - nieoczekiwany błąd:', err.message);
    }
}

// Harmonogram: co godzinę (dokładniejsze niż raz dziennie, bo 24h to już wąski margines)
cron.schedule('0 * * * *', processUnservedReservations, { timezone: 'Europe/Warsaw' });

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Serwer uruchomiony na porcie ${PORT}`);
    console.log(`📧 Email nadawca: ${EMAIL_FROM}`);
    console.log(`🔑 Resend API: ${RESEND_API_KEY ? 'skonfigurowany' : 'BRAK KLUCZA'}`);
    console.log(`🗄️  Supabase: ${SUPABASE_URL ? 'skonfigurowany' : 'BRAK KONFIGURACJI'}`);
    console.log(`⏰ Codzienne podsumowanie Telegram: zaplanowane na 8:00 (Europe/Warsaw)`);
});

module.exports = app;
