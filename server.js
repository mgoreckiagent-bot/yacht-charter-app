const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');

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
        isClubReservation: row.is_club_reservation || false
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

const YACHT_PRICES = { enn: 80, first: 80, omega: 80 };
const TACKLE_PRICE = 50;
const SKIPPER_HOURLY_PRICE = 50;

// Jachty "enn" i "first" traktowane jako zamienne przy kolizji terminu
const INTERCHANGEABLE_YACHT = { enn: 'first', first: 'enn' };

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
        `Akceptacja rezerwacji - ${reservation.id}`,
        `
            <h2>Rezerwacja Zatwierdzona! ✅</h2>
            <h3>Szczegóły rezerwacji:</h3>
            <ul>
                <li><strong>ID Rezerwacji:</strong> ${reservation.id}</li>
                <li><strong>Jacht:</strong> ${reservation.yacht.toUpperCase()}</li>
                <li><strong>Data:</strong> ${new Date(reservation.date).toLocaleDateString('pl-PL')}</li>
                <li><strong>Czas:</strong> ${reservation.startTime} (${reservation.hours}h)</li>
                <li><strong>Razem do zapłaty:</strong> ${reservation.totalPrice} zł</li>
                <li><strong>Kaucja zwrotna:</strong> 500 zł</li>
            </ul>
            <h3>Dane opiekuna czarteru:</h3>
            <ul>
                <li><strong>Imię i nazwisko:</strong> ${admin.name}</li>
                <li><strong>Telefon:</strong> <a href="tel:${admin.phone}">${admin.phone}</a></li>
            </ul>
            <p>Pozdrawiamy,<br>Klub Żeglarski</p>
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
    const { clubRevenue, skipperRevenue } = calculateRevenueSplit(yacht, parsedHours, Boolean(tackle), Boolean(skipper));

    const { data, error } = await supabase
        .from('reservations')
        .insert({
            id,
            yacht,
            date,
            start_time: startTime,
            hours: parsedHours,
            tackle: Boolean(tackle),
            skipper: Boolean(skipper),
            total_price: parseInt(totalPrice),
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
        `Rezerwacja czarteru - ${reservation.id}`,
        `
            <h2>Potwierdzenie Rezerwacji</h2>
            <p>Dziękujemy za rezerwację!</p>
            <h3>Szczegóły rezerwacji:</h3>
            <ul>
                <li><strong>ID Rezerwacji:</strong> ${reservation.id}</li>
                <li><strong>Jacht:</strong> ${reservation.yacht.toUpperCase()}</li>
                <li><strong>Data:</strong> ${new Date(reservation.date).toLocaleDateString('pl-PL')}</li>
                <li><strong>Czas:</strong> ${reservation.startTime} (${reservation.hours}h)</li>
                <li><strong>Razem do zapłaty:</strong> ${reservation.totalPrice} zł</li>
                <li><strong>Kaucja zwrotna:</strong> 500 zł</li>
            </ul>
            <p>Status rezerwacji: <strong>Oczekuje na akceptację klubu</strong></p>
            <p>Pozdrawiamy,<br>Klub Żeglarski</p>
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

    const { data, error } = await supabase
        .from('reservations')
        .insert({
            id,
            yacht,
            date,
            start_time: startTime,
            hours: parsedHours,
            tackle: false,
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
        updates.total_price = calculateTotalPrice(effectiveYacht, effectiveHours, currentRes.tackle, currentRes.skipper);
        const revenueSplit = calculateRevenueSplit(effectiveYacht, effectiveHours, currentRes.tackle, currentRes.skipper);
        updates.club_revenue = revenueSplit.clubRevenue;
        updates.skipper_revenue = revenueSplit.skipperRevenue;
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

    if (assignedAdmin) {
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

    if (!reservation.isClubReservation) {
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
        .gte('date', startDate)
        .lte('date', endDate);

    if (error) {
        console.error('Supabase select error:', error);
        return res.status(500).json({ error: 'Błąd pobierania danych do raportu' });
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
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Serwer uruchomiony na porcie ${PORT}`);
    console.log(`📧 Email nadawca: ${EMAIL_FROM}`);
    console.log(`🔑 Resend API: ${RESEND_API_KEY ? 'skonfigurowany' : 'BRAK KLUCZA'}`);
    console.log(`🗄️  Supabase: ${SUPABASE_URL ? 'skonfigurowany' : 'BRAK KONFIGURACJI'}`);
});

module.exports = app;
