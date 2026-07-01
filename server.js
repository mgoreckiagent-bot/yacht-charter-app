const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// CONFIGURATION
// ============================================

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'klub123';

// Email configuration - adjust to your email provider
const transporter = nodemailer.createTransport({
    service: 'gmail', // or any other email service
    auth: {
        user: process.env.EMAIL_USER || 'your-email@gmail.com',
        pass: process.env.EMAIL_PASSWORD || 'your-app-password'
    }
});

// In-memory storage (replace with database in production)
let reservations = [];
let admins = [
    { id: 1, name: 'Jan Kowalski', phone: '+48 123 456 789', email: 'jan@club.local' },
    { id: 2, name: 'Maria Nowak', phone: '+48 987 654 321', email: 'maria@club.local' },
    { id: 3, name: 'Piotr Wójcik', phone: '+48 555 666 777', email: 'piotr@club.local' }
];

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
        req.admin = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Nieprawidłowy token' });
    }
}

// ============================================
// AUTHENTICATION ENDPOINTS
// ============================================

// Admin login
app.post('/api/auth/login', (req, res) => {
    const { password } = req.body;

    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Błędne hasło' });
    }

    const token = jwt.sign(
        { role: 'admin', timestamp: Date.now() },
        JWT_SECRET,
        { expiresIn: '24h' }
    );

    res.json({ token, message: 'Zalogowano pomyślnie' });
});

// ============================================
// RESERVATION ENDPOINTS
// ============================================

// Create reservation
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

    // Send confirmation email to customer
    sendCustomerConfirmationEmail(reservation);

    // Notify admins
    notifyAdminsNewReservation(reservation);

    res.status(201).json({ message: 'Rezerwacja utworzona', reservation });
});

// Get all reservations (admin only)
app.get('/api/reservations', verifyAdminToken, (req, res) => {
    res.json(reservations);
});

// Get reservation by ID
app.get('/api/reservations/:id', (req, res) => {
    const reservation = reservations.find(r => r.id === req.params.id);

    if (!reservation) {
        return res.status(404).json({ error: 'Rezerwacja nie znaleziona' });
    }

    res.json(reservation);
});

// Update reservation (admin only)
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

            // Send approval email to customer
            sendCustomerApprovalEmail(reservation);
        }
    }

    res.json({ message: 'Rezerwacja zaktualizowana', reservation });
});

// Cancel reservation
app.delete('/api/reservations/:id', verifyAdminToken, (req, res) => {
    const index = reservations.findIndex(r => r.id === req.params.id);

    if (index === -1) {
        return res.status(404).json({ error: 'Rezerwacja nie znaleziona' });
    }

    const reservation = reservations[index];
    reservations.splice(index, 1);

    // Send cancellation email to customer
    sendCustomerCancellationEmail(reservation);

    res.json({ message: 'Rezerwacja anulowana' });
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// Get all admins
app.get('/api/admins', verifyAdminToken, (req, res) => {
    res.json(admins);
});

// Add new admin
app.post('/api/admins', verifyAdminToken, (req, res) => {
    const { name, phone, email } = req.body;

    if (!name || !phone || !email) {
        return res.status(400).json({ error: 'Brakuje wymaganych pól' });
    }

    const newAdmin = {
        id: Math.max(...admins.map(a => a.id), 0) + 1,
        name,
        phone,
        email
    };

    admins.push(newAdmin);

    res.status(201).json({ message: 'Opiekun dodany', admin: newAdmin });
});

// ============================================
// EMAIL SENDING FUNCTIONS
// ============================================

async function sendCustomerConfirmationEmail(reservation) {
    const mailOptions = {
        from: process.env.EMAIL_USER || 'noreply@club.local',
        to: reservation.customerEmail,
        subject: `Rezerwacja czarteru - ${reservation.id}`,
        html: `
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
            
            <p>Otrzymasz potwierdzenie wraz z danymi opiekuna na tym adresie email.</p>
            
            <p>Pozdrawiamy,<br>Klub Żeglarski</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Confirmation email sent to ${reservation.customerEmail}`);
    } catch (err) {
        console.error('Email error:', err);
    }
}

async function sendCustomerApprovalEmail(reservation) {
    const mailOptions = {
        from: process.env.EMAIL_USER || 'noreply@club.local',
        to: reservation.customerEmail,
        subject: `Akceptacja rezerwacji - ${reservation.id}`,
        html: `
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
            ${reservation.admin ? `
                <ul>
                    <li><strong>Imię i nazwisko:</strong> ${reservation.admin.name}</li>
                    <li><strong>Telefon:</strong> <a href="tel:${reservation.admin.phone}">${reservation.admin.phone}</a></li>
                </ul>
            ` : ''}
            
            <h3>Warunki rezerwacji:</h3>
            <ul>
                <li>Jacht powinien być przejęty o ${reservation.startTime}</li>
                <li>Jacht powinien być zwrócony w tym samym stanie</li>
                <li>Odpowiedzialność za uszkodzenia ponosi czarterobiorca</li>
                <li>Kaucja zostanie zwrócona w ciągu 3 dni roboczych</li>
            </ul>
            
            <p>Pozdrawiamy,<br>Klub Żeglarski</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Approval email sent to ${reservation.customerEmail}`);
    } catch (err) {
        console.error('Email error:', err);
    }
}

async function sendCustomerCancellationEmail(reservation) {
    const mailOptions = {
        from: process.env.EMAIL_USER || 'noreply@club.local',
        to: reservation.customerEmail,
        subject: `Anulowanie rezerwacji - ${reservation.id}`,
        html: `
            <h2>Rezerwacja Anulowana</h2>
            <p>Rezerwacja czarteru jachtu ${reservation.yacht.toUpperCase()} na dzień ${new Date(reservation.date).toLocaleDateString('pl-PL')} została anulowana.</p>
            <p>Kontaktuj się z klubem, aby uzyskać więcej informacji.</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Cancellation email sent to ${reservation.customerEmail}`);
    } catch (err) {
        console.error('Email error:', err);
    }
}

async function notifyAdminsNewReservation(reservation) {
    const adminEmails = admins.map(a => a.email).join(', ');
    
    const mailOptions = {
        from: process.env.EMAIL_USER || 'noreply@club.local',
        to: adminEmails,
        subject: `Nowa rezerwacja - ${reservation.id}`,
        html: `
            <h2>Nowa Rezerwacja Czarteru</h2>
            
            <h3>Szczegóły:</h3>
            <ul>
                <li><strong>ID:</strong> ${reservation.id}</li>
                <li><strong>Jacht:</strong> ${reservation.yacht.toUpperCase()}</li>
                <li><strong>Data:</strong> ${new Date(reservation.date).toLocaleDateString('pl-PL')}</li>
                <li><strong>Czas:</strong> ${reservation.startTime} (${reservation.hours}h)</li>
                <li><strong>Cena:</strong> ${reservation.totalPrice} zł</li>
            </ul>
            
            <h3>Klient:</h3>
            <ul>
                <li><strong>Imię:</strong> ${reservation.customerName}</li>
                <li><strong>Email:</strong> ${reservation.customerEmail}</li>
                <li><strong>Telefon:</strong> ${reservation.customerPhone}</li>
            </ul>
            
            <p><a href="https://your-app-url.com">Zaakceptuj rezerwację w panelu</a></p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Notification sent to admins`);
    } catch (err) {
        console.error('Email error:', err);
    }
}

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
    res.json({ status: 'OK' });
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
    console.log(`📧 Email service: ${process.env.EMAIL_USER || 'Nie skonfigurowany'}`);
    console.log(`🔐 JWT Secret: ${JWT_SECRET ? 'Ustawiony' : 'Domyślny (zmień!)'}`);
});

module.exports = app;
