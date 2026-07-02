const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
            // Nigdy nie cachuj index.html - zawsze pobieraj najświeższą wersję po deployu
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

let reservations = [];
let admins = [
    { id: 1, name: 'Jan Kowalski', phone: '+48 123 456 789', email: 'jan@club.local' },
    { id: 2, name: 'Maria Nowak', phone: '+48 987 654 321', email: 'maria@club.local' },
    { id: 3, name: 'Piotr Wójcik', phone: '+48 555 666 777', email: 'piotr@club.local' }
];

// Niedostępności opiekunów: { id, adminId, date }
let unavailability = [];

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
// AUTHENTICATION ENDPOINTS
// ============================================

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

app.post('/api/reservations', (req, res) => {
    const { yacht, date, startTime, hours, tackle, skipper, totalPrice, customerName, customerEmail, customerPhone } = req.body;

    if (!yacht || !date || !startTime || !hours || !customerName || !customerEmail) {
        return res.status(400).json({ error: 'Brakuje wymaganych pól' });
    }

    const reservation = {
        id: 'RES-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
        yacht,
        date,
        startTime,
        hours: parseInt(hours),
        tackle: Boolean(tackle),
        skipper: Boolean(skipper),
        totalPrice: parseInt(totalPrice),
        customerName,
        customerEmail,
        customerPhone,
        status: 'pending',
        admin: null,
        createdAt: new Date().toISOString()
    };

    reservations.push(reservation);

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

    const adminEmails = admins.map(a => a.email).filter(e => e && !e.endsWith('@club.local'));
    if (adminEmails.length > 0) {
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
    }

    res.status(201).json({ message: 'Rezerwacja utworzona', reservation });
});

app.get('/api/reservations', verifyAdminToken, (req, res) => {
    res.json(reservations);
});

app.get('/api/reservations/:id', (req, res) => {
    const reservation = reservations.find(r => r.id === req.params.id);

    if (!reservation) {
        return res.status(404).json({ error: 'Rezerwacja nie znaleziona' });
    }

    res.json(reservation);
});

app.patch('/api/reservations/:id', verifyAdminToken, (req, res) => {
    const reservation = reservations.find(r => r.id === req.params.id);

    if (!reservation) {
        return res.status(404).json({ error: 'Rezerwacja nie znaleziona' });
    }

    const { status, adminId } = req.body;

    if (status) {
        reservation.status = status;
    }

    if (adminId) {
        const admin = admins.find(a => a.id === adminId);
        if (admin) {
            reservation.admin = admin;
            reservation.status = 'approved';

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
    }

    res.json({ message: 'Rezerwacja zaktualizowana', reservation });
});

app.delete('/api/reservations/:id', verifyAdminToken, (req, res) => {
    const index = reservations.findIndex(r => r.id === req.params.id);

    if (index === -1) {
        return res.status(404).json({ error: 'Rezerwacja nie znaleziona' });
    }

    const reservation = reservations[index];
    reservations.splice(index, 1);

    sendEmail(
        reservation.customerEmail,
        `Anulowanie rezerwacji - ${reservation.id}`,
        `
            <h2>Rezerwacja Anulowana</h2>
            <p>Rezerwacja czarteru jachtu ${reservation.yacht.toUpperCase()} na dzień ${new Date(reservation.date).toLocaleDateString('pl-PL')} została anulowana.</p>
        `
    );

    res.json({ message: 'Rezerwacja anulowana' });
});

// ============================================
// ADMIN (SKIPPER) ENDPOINTS
// ============================================

app.get('/api/admins', verifyAnyToken, (req, res) => {
    res.json(admins);
});

app.post('/api/admins', verifyAdminToken, (req, res) => {
    const { name, phone, email } = req.body;

    if (!name || !phone) {
        return res.status(400).json({ error: 'Brakuje wymaganych pól' });
    }

    const newAdmin = {
        id: Math.max(...admins.map(a => a.id), 0) + 1,
        name,
        phone,
        email: email || ''
    };

    admins.push(newAdmin);

    res.status(201).json({ message: 'Opiekun dodany', admin: newAdmin });
});

app.patch('/api/admins/:id', verifyAdminToken, (req, res) => {
    const admin = admins.find(a => a.id === parseInt(req.params.id));

    if (!admin) {
        return res.status(404).json({ error: 'Opiekun nie znaleziony' });
    }

    const { name, phone, email } = req.body;

    if (name) admin.name = name;
    if (phone) admin.phone = phone;
    if (email !== undefined) admin.email = email;

    res.json({ message: 'Opiekun zaktualizowany', admin });
});

app.delete('/api/admins/:id', verifyAdminToken, (req, res) => {
    const index = admins.findIndex(a => a.id === parseInt(req.params.id));

    if (index === -1) {
        return res.status(404).json({ error: 'Opiekun nie znaleziony' });
    }

    admins.splice(index, 1);

    res.json({ message: 'Opiekun usunięty' });
});

// ============================================
// UNAVAILABILITY ENDPOINTS (niedostępność opiekunów)
// ============================================

app.get('/api/unavailability', verifyAnyToken, (req, res) => {
    res.json(unavailability);
});

app.post('/api/unavailability', verifyAnyToken, (req, res) => {
    const { adminId, date } = req.body;

    if (!adminId || !date) {
        return res.status(400).json({ error: 'Brakuje wymaganych pól' });
    }

    const exists = unavailability.find(u => u.adminId === adminId && u.date === date);
    if (exists) {
        return res.status(200).json({ message: 'Już oznaczone', entry: exists });
    }

    const entry = {
        id: 'UNAV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
        adminId,
        date
    };

    unavailability.push(entry);

    res.status(201).json({ message: 'Dzień oznaczony jako niedostępny', entry });
});

app.delete('/api/unavailability/:id', verifyAnyToken, (req, res) => {
    const index = unavailability.findIndex(u => u.id === req.params.id);

    if (index === -1) {
        return res.status(404).json({ error: 'Wpis nie znaleziony' });
    }

    unavailability.splice(index, 1);

    res.json({ message: 'Wpis usunięty' });
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
});

module.exports = app;
