# 📚 DOKUMENTASI API KIOSWEB3 V3.0

**Dokumentasi Lengkap untuk Integrasi Frontend**

> 📅 **Terakhir Diupdate:** 30 Desember 2025
> 🔖 **Versi:** 3.0 (Post-Audit Edition)  
> 🎯 **Status:** Production Ready ✅

---

## 📋 DAFTAR ISI

1. [Environment & Setup](#-1-environment--setup)
2. [Modul Otentikasi (Auth)](#-2-modul-otentikasi-auth)
3. [Modul Pengguna (User)](#-3-modul-pengguna-user)
4. [Modul Transaksi (Order)](#-4-modul-transaksi-order)
5. [Modul Pembayaran (Payment)](#-5-modul-pembayaran-payment)
6. [Modul Harga & Stok (Pricing)](#-6-modul-harga--stok-pricing)
7. [Modul Inventaris (Inventory)](#-7-modul-inventaris-inventory)
8. [Modul Voucher](#-8-modul-voucher)
9. [Modul Referral](#-9-modul-referral)
10. [Modul Admin Dashboard](#-10-modul-admin-dashboard)
11. [Error Handling](#-11-error-handling)
12. [Flowchart Alur Transaksi](#-12-flowchart-alur-transaksi)

---

## 🌍 1. ENVIRONMENT & SETUP

### Base URLs
| Environment | URL |
|-------------|-----|
| **Development** | `http://localhost:3000` |
| **Production** | `https://api.kiosweb3.com` |

### Headers Wajib (Authenticated Routes)
```http
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

### Status Pesanan (Order Status)
| Status | Deskripsi |
|--------|-----------|
| `PENDING` | Menunggu pembayaran |
| `PAID` | Pembayaran diterima, menunggu proses |
| `PROCESSING` | Token sedang dikirim ke wallet |
| `SUCCESS` | Transaksi berhasil |
| `FAILED` | Transaksi gagal |
| `EXPIRED` | Waktu pembayaran habis (1 jam) |
| `CANCELLED` | Dibatalkan oleh user/sistem |

---

## 🔐 2. MODUL OTENTIKASI (AUTH)

**Base URL:** `/api/auth`

### 2.1 Daftar Akun - Langkah 1 (Kirim OTP)

Memulai proses registrasi dengan mengirim OTP ke email.

```http
POST /api/auth/register/init
```

**Request Body:**
```json
{
    "email": "user@example.com",
    "password": "MinPassword6Char",
    "name": "Nama Lengkap",
    "referralCode": "REFERRAL123"  // Opsional
}
```

**Response Sukses (200):**
```json
{
    "message": "OTP sent to email. Please verify to activate account."
}
```

**Possible Errors:**
| Code | Error | Solusi |
|------|-------|--------|
| 400 | `Email already registered` | User sudah terdaftar, arahkan ke Login |
| 400 | `Valid email and password (min 6 chars) required` | Validasi input di frontend |

---

### 2.2 Daftar Akun - Langkah 2 (Verifikasi OTP)

Verifikasi OTP dan buat akun baru.

```http
POST /api/auth/register/complete
```

**Request Body:**
```json
{
    "email": "user@example.com",
    "otp": "123456"
}
```

**Response Sukses (201):**
```json
{
    "message": "Registration successful",
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
        "id": "uuid-xxx",
        "name": "Nama Lengkap",
        "email": "user@example.com",
        "referralCode": "USER123"
    }
}
```

**Catatan Penting:**
- OTP berlaku **5 menit**
- Simpan `token` di localStorage/SecureStorage
- Rate limited: **5 request per 15 menit**

---

### 2.3 Login (Email & Password)

```http
POST /api/auth/login
```

**Request Body:**
```json
{
    "email": "user@example.com",
    "password": "UserPassword123"
}
```

**Response Sukses (200):**
```json
{
    "message": "Login successful",
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
        "id": "uuid-xxx",
        "name": "Nama Lengkap",
        "email": "user@example.com",
        "referralCode": "USER123",
        "telegramId": null,
        "telegramUsername": null
    }
}
```

---

### 2.4 Login via Google

```http
POST /api/auth/google
```

**Request Body:**
```json
{
    "idToken": "google_id_token_from_firebase"
}
```

**Response:** Sama dengan Login biasa.

**Frontend Implementation:**
```javascript
// Firebase / Google Sign-In
const result = await signInWithPopup(auth, googleProvider);
const idToken = await result.user.getIdToken();

// Kirim ke backend
const response = await fetch('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ idToken })
});
```

---

### 2.5 Generate Kode Link Telegram

Membuat kode 6 digit untuk menghubungkan akun Web ke Bot Telegram.

```http
POST /api/auth/link/generate-code
Authorization: Bearer <token>
```

**Response Sukses (200):**
```json
{
    "code": "847291",
    "expiresIn": 600,
    "message": "Kode berhasil dibuat. Masukkan kode ini di Telegram Bot."
}
```

**Frontend UX Flow:**
1. Tampilkan kode dengan countdown timer (10 menit)
2. User buka Bot Telegram → pilih "Sambungkan Akun Web"
3. User input kode di Bot
4. Bot minta OTP via email untuk konfirmasi
5. Setelah OTP valid, akun terhubung

**Rate Limit:** Max 3 kode per 10 menit

---

### 2.6 Lupa Password - Request OTP

```http
POST /api/auth/forgot-password
```

**Request Body:**
```json
{
    "email": "user@example.com"
}
```

**Response Sukses (200):**
```json
{
    "message": "OTP sent to email. Please verify to reset password."
}
```

---

### 2.7 Reset Password

```http
POST /api/auth/reset-password
```

**Request Body:**
```json
{
    "email": "user@example.com",
    "otp": "123456",
    "newPassword": "NewSecurePassword123"
}
```

**Response Sukses (200):**
```json
{
    "message": "Password reset successful. You can now login."
}
```

---

## 👤 3. MODUL PENGGUNA (USER)

**Base URL:** `/api/users`  
**Header:** `Authorization: Bearer <token>` (Wajib)

### 3.1 Lihat Profil Saya

```http
GET /api/users/me
```

**Response (200):**
```json
{
    "user": {
        "id": "uuid-xxx",
        "name": "Budi Santoso",
        "email": "budi@example.com",
        "telegramId": "123456789",
        "telegramUsername": "budisantoso",
        "referralCode": "BUDI123",
        "createdAt": "2024-01-15T10:30:00Z"
    },
    "stats": {
        "totalOrders": 15,
        "successfulOrders": 12,
        "totalSpent": 1500000,
        "voucherBalance": 30000
    }
}
```

---

### 3.2 Update Profil

```http
PUT /api/users/me
```

**Request Body:**
```json
{
    "name": "Budi Santoso Jr",
    "email": "budi.new@example.com"
}
```

**Response:** Object user yang sudah diupdate.

---

## 🛒 4. MODUL TRANSAKSI (ORDER)

**Base URL:** `/api/orders`  
**Header:** `Authorization: Bearer <token>` (Wajib)  
**Rate Limit:** 10 orders per jam

### 4.1 Buat Pesanan Baru (Step 1: Checkout)

> ⚠️ **PENTING:** Endpoint ini membuat pesanan dengan status PENDING.  
> User harus lanjut ke `/pay` untuk generate tagihan pembayaran.

```http
POST /api/orders
```

**Request Body:**
```json
{
    "chain": "bsc",
    "amountIdr": 100000,
    "walletAddress": "0x1234567890abcdef1234567890abcdef12345678",
    "voucherCode": "PROMO50K"
}
```

**Validasi Input:**
| Field | Rules |
|-------|-------|
| `chain` | `bsc`, `eth`, atau `base` |
| `amountIdr` | Min: Rp 10.000, Max: Rp 50.000.000 |
| `amountIdr` (ETH) | Min: Rp 500.000 (khusus ETH Mainnet) |
| `walletAddress` | Format EVM: `0x` + 40 karakter hex |
| `voucherCode` | Opsional |

**Response Sukses (201):**
```json
{
    "order": {
        "id": "order-uuid-xxx",
        "chain": "bsc",
        "symbol": "BNB",
        "amountIdr": 100000,
        "amountToken": "0.015234",
        "walletAddress": "0x1234...5678",
        "status": "PENDING",
        "createdAt": "2024-12-30T10:00:00Z"
    }
}
```

**Error Response (409 - Pending Order Ada):**
```json
{
    "error": "PENDING_ORDER_EXISTS",
    "message": "Anda masih memiliki pesanan aktif yang belum dibayar.",
    "pendingOrder": {
        "id": "order-uuid-old",
        "chain": "bsc",
        "amountIdr": 50000,
        "createdAt": "2024-12-30T09:00:00Z"
    }
}
```

**Frontend Handling untuk Error 409:**
```javascript
if (response.status === 409) {
    const data = await response.json();
    showModal({
        title: "Pesanan Aktif Ditemukan",
        message: data.message,
        actions: [
            { text: "Lanjutkan Bayar", link: `/order/${data.pendingOrder.id}` },
            { text: "Batalkan Dulu", action: () => cancelOrder(data.pendingOrder.id) }
        ]
    });
}
```

---

### 4.2 Pilih Metode Pembayaran (Step 2: Pay)

```http
POST /api/orders/:id/pay
```

**Request Body:**
```json
{
    "method": "QRIS"
}
```

| Method | Deskripsi | Fee |
|--------|-----------|-----|
| `QRIS` | Scan QR via e-wallet apapun | **GRATIS** |
| `VA` | Transfer Bank Virtual Account | Rp 4.000 |

**Response Sukses (200):**
```json
{
    "orderId": "KIOS-1703912345-ABC",
    "paymentUrl": "https://app.sandbox.midtrans.com/snap/v2/vtweb/xxx",
    "qrImage": "data:image/png;base64,iVBORw0KGgo...",
    "fee": 0,
    "totalPay": 100000,
    "expiryTime": "2024-12-30T11:00:00Z"
}
```

**Frontend UX:**
- Jika `QRIS`: Tampilkan `qrImage` sebagai `<img src={qrImage} />`
- Jika `VA`: Tampilkan `paymentUrl` sebagai link atau iframe
- Tampilkan countdown timer dari `expiryTime` (1 jam)

---

### 4.3 Cek Status Pembayaran (Polling)

```http
POST /api/orders/:id/sync
```

**Response (200):**
```json
{
    "status": "PENDING"
}
```

**Frontend Polling Strategy:**
```javascript
const pollStatus = async (orderId) => {
    const interval = setInterval(async () => {
        const res = await fetch(`/api/orders/${orderId}/sync`, { method: 'POST' });
        const { status } = await res.json();
        
        if (status === 'PAID' || status === 'PROCESSING') {
            showSuccess("Pembayaran diterima! Token sedang diproses...");
            clearInterval(interval);
        } else if (status === 'SUCCESS') {
            showSuccess("Token berhasil dikirim!");
            clearInterval(interval);
            redirect(`/order/${orderId}/success`);
        } else if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(status)) {
            showError("Transaksi gagal atau dibatalkan.");
            clearInterval(interval);
        }
    }, 5000); // Poll setiap 5 detik
    
    // Timeout after 1 hour
    setTimeout(() => clearInterval(interval), 3600000);
};
```

---

### 4.4 Batalkan Pesanan

```http
POST /api/orders/:id/cancel
```

**Response Sukses (200):**
```json
{
    "success": true,
    "message": "Pesanan berhasil dibatalkan."
}
```

**Error Responses:**
| Code | Message | Keterangan |
|------|---------|------------|
| 400 | `Pembayaran sudah diterima. Pesanan sedang diproses...` | Tidak bisa cancel setelah bayar |
| 400 | `Pesanan sudah selesai...` | Sudah SUCCESS |
| 200 | `Pesanan sudah dibatalkan/kadaluarsa.` | Idempotent response |

---

### 4.5 Riwayat Pesanan Saya

```http
GET /api/orders?page=0&limit=10
```

**Query Parameters:**
| Param | Type | Default | Deskripsi |
|-------|------|---------|-----------|
| `page` | number | 0 | Halaman (0-indexed) |
| `limit` | number | 10 | Jumlah per halaman |

**Response (200):**
```json
{
    "orders": [
        {
            "id": "order-uuid",
            "chain": "bsc",
            "symbol": "BNB",
            "amountIdr": 100000,
            "amountToken": "0.015234",
            "status": "SUCCESS",
            "txHash": "0xabc123...",
            "createdAt": "2024-12-30T10:00:00Z"
        }
    ],
    "total": 15,
    "page": 0,
    "limit": 10
}
```

---

### 4.6 Detail Pesanan

```http
GET /api/orders/:id
```

**Response (200):**
```json
{
    "order": {
        "id": "order-uuid",
        "chain": "bsc",
        "symbol": "BNB",
        "amountIdr": 100000,
        "amountToken": "0.015234",
        "markupPercent": 5,
        "walletAddress": "0x1234...5678",
        "status": "SUCCESS",
        "txHash": "0xabc123def456...",
        "midtransId": "KIOS-1703912345-ABC",
        "paymentMethod": "QRIS",
        "totalPay": 100000,
        "createdAt": "2024-12-30T10:00:00Z",
        "paidAt": "2024-12-30T10:05:00Z"
    },
    "explorerUrl": "https://bscscan.com/tx/0xabc123def456..."
}
```

---

## 💳 5. MODUL PEMBAYARAN (PAYMENT)

**Base URL:** `/api/payments`

### 5.1 Webhook Midtrans

> ⚠️ **INTERNAL USE ONLY** - Endpoint ini dipanggil oleh Midtrans, bukan frontend.

```http
POST /api/payments/webhook
```

### 5.2 Cek Status Pembayaran Manual

```http
POST /api/payments/check/:orderId
```

**Response (200):**
```json
{
    "orderId": "order-uuid",
    "orderStatus": "PENDING",
    "paymentStatus": "pending"
}
```

### 5.3 Halaman Finish Payment

```http
GET /api/payments/finish?order_id=xxx&transaction_status=settlement
```

Redirect page setelah user selesai bayar di Midtrans.

---

## 📊 6. MODUL HARGA & STOK (PRICING)

**Base URL:** `/api/pricing` (Public - No Auth Required)

### 6.1 Daftar Harga Semua Chain

```http
GET /api/pricing
```

**Response (200):**
```json
{
    "prices": [
        {
            "chain": "bsc",
            "symbol": "BNB",
            "name": "BNB Smart Chain",
            "priceUsd": "650.25"
        },
        {
            "chain": "eth",
            "symbol": "ETH",
            "name": "Ethereum",
            "priceUsd": "3456.78"
        },
        {
            "chain": "base",
            "symbol": "ETH",
            "name": "Base",
            "priceUsd": "3456.78"
        }
    ],
    "usdIdrRate": 15800,
    "markupPercent": 5
}
```

---

### 6.2 Kalkulator Harga (Quote)

> 🔥 **WAJIB GUNAKAN** sebelum checkout untuk validasi stok!

```http
GET /api/pricing/quote?chain=bsc&amountIdr=100000
```

**Query Parameters:**
| Param | Type | Required | Deskripsi |
|-------|------|----------|-----------|
| `chain` | string | ✅ | `bsc`, `eth`, atau `base` |
| `amountIdr` | number | ✅ | Nominal Rupiah (min: 50000) |

**Response (200):**
```json
{
    "chain": "bsc",
    "symbol": "BNB",
    "amountIdr": 100000,
    "tokenAmount": "0.015234",
    "tokenPriceUsd": "650.25",
    "usdIdrRate": 15800,
    "markupPercent": 5,
    "effectivePriceIdr": "10785000",
    "inventoryStatus": "AVAILABLE",
    "maxBuyIdr": 5000000
}
```

**Inventory Status:**
| Status | Keterangan | UI Suggestion |
|--------|------------|---------------|
| `AVAILABLE` | Stok mencukupi | ✅ Hijau - "Stok Tersedia" |
| `LIMITED` | Stok terbatas (<2x order) | 🟡 Kuning - "Stok Terbatas!" |
| `OUT_OF_STOCK` | Stok tidak cukup | 🔴 Merah - "Stok Habis" |

**Frontend Implementation:**
```jsx
const Quote = ({ quote }) => (
    <div>
        <p>Anda akan mendapat: {quote.tokenAmount} {quote.symbol}</p>
        
        {quote.inventoryStatus === 'OUT_OF_STOCK' && (
            <Alert type="error">
                Stok tidak mencukupi. Maksimal beli: Rp {quote.maxBuyIdr.toLocaleString()}
            </Alert>
        )}
        
        {quote.inventoryStatus === 'LIMITED' && (
            <Alert type="warning">
                Stok terbatas! Segera checkout sebelum kehabisan.
            </Alert>
        )}
        
        <Button 
            disabled={quote.inventoryStatus === 'OUT_OF_STOCK'}
            onClick={checkout}
        >
            Checkout
        </Button>
    </div>
);
```

---

### 6.3 Update Pricing Settings (Admin)

```http
POST /api/pricing/settings
Authorization: Bearer <admin_token>
```

**Request Body:**
```json
{
    "usdIdrRate": 16000,
    "markupPercent": 6
}
```

---

## 📦 7. MODUL INVENTARIS (INVENTORY)

**Base URL:** `/api/inventory`

### 7.1 Lihat Semua Stok

```http
GET /api/inventory
```

**Response (200):**
```json
{
    "inventory": [
        {
            "chain": "bsc",
            "symbol": "BNB",
            "balance": "10.5000",
            "reserved": "0.2500",
            "available": "10.2500"
        },
        {
            "chain": "eth",
            "symbol": "ETH",
            "balance": "2.0000",
            "reserved": "0.1000",
            "available": "1.9000"
        }
    ]
}
```

**Keterangan:**
- `balance`: Total stok di hot wallet
- `reserved`: Stok yang sedang diproses (order PENDING/PROCESSING)
- `available`: Stok yang bisa dibeli = balance - reserved

---

### 7.2 Lihat Stok per Chain

```http
GET /api/inventory/:chain?symbol=BNB
```

**Response (200):**
```json
{
    "chain": "bsc",
    "symbol": "BNB",
    "balance": "10.5000",
    "reserved": "0.2500",
    "available": "10.2500"
}
```

---

### 7.3 Update Stok Manual (Admin)

```http
POST /api/inventory/:chain
Authorization: Bearer <admin_token>
```

**Request Body:**
```json
{
    "balance": "15.0000",
    "symbol": "BNB"
}
```

---

### 7.4 Sync Stok dengan Blockchain (Admin)

```http
POST /api/inventory/sync
Authorization: Bearer <admin_token>
```

**Response (200):**
```json
{
    "message": "Inventory sync started"
}
```

---

## 🎟️ 8. MODUL VOUCHER

**Base URL:** `/api/vouchers`  
**Header:** `Authorization: Bearer <token>` (Wajib)

### 8.1 Lihat Voucher Saya

```http
GET /api/vouchers
```

**Response (200):**
```json
{
    "vouchers": [
        {
            "id": "voucher-uuid",
            "code": "REFERRAL10K",
            "value": 10000,
            "valueFormatted": "Rp 10.000",
            "usedAt": null,
            "expiresAt": "2025-06-30T23:59:59Z",
            "createdAt": "2024-12-01T10:00:00Z"
        }
    ],
    "balance": 10000,
    "balanceFormatted": "Rp 10.000"
}
```

---

### 8.2 Lihat Voucher yang Bisa Dipakai

```http
GET /api/vouchers/available
```

**Response (200):**
```json
{
    "vouchers": [
        {
            "id": "voucher-uuid",
            "code": "REFERRAL10K",
            "value": 10000,
            "valueFormatted": "Rp 10.000",
            "expiresAt": "2025-06-30T23:59:59Z"
        }
    ]
}
```

---

### 8.3 Detail Voucher

```http
GET /api/vouchers/:code
```

**Response (200):**
```json
{
    "voucher": {
        "id": "voucher-uuid",
        "code": "REFERRAL10K",
        "value": 10000,
        "valueFormatted": "Rp 10.000",
        "usedAt": null,
        "expiresAt": "2025-06-30T23:59:59Z",
        "createdAt": "2024-12-01T10:00:00Z"
    }
}
```

---

## 🎁 9. MODUL REFERRAL

**Base URL:** `/api/referrals`  
**Header:** `Authorization: Bearer <token>` (Wajib)

### 9.1 Info Referral Saya

```http
GET /api/referrals
```

**Response (200):**
```json
{
    "referralCode": "BUDI123",
    "stats": {
        "total": 25,
        "valid": 18,
        "pending": 7,
        "totalEarned": 90000,
        "totalEarnedFormatted": "Rp 90.000"
    },
    "rewards": {
        "perReferral": 5000,
        "perReferralFormatted": "Rp 5.000",
        "minOrdersRequired": 1
    }
}
```

**Penjelasan:**
- `total`: Total orang yang pakai kode referral saya
- `valid`: Yang sudah menyelesaikan minimal 1 order
- `pending`: Yang belum order
- `totalEarned`: Total voucher yang sudah didapat dari referral

---

### 9.2 Daftar Referral Saya

```http
GET /api/referrals/list
```

**Response (200):**
```json
{
    "referrals": [
        {
            "id": "referral-uuid",
            "isValid": true,
            "rewardGiven": true,
            "createdAt": "2024-12-01T10:00:00Z",
            "validatedAt": "2024-12-05T15:30:00Z"
        }
    ]
}
```

---

## 🛡️ 10. MODUL ADMIN DASHBOARD

**Base URL:** `/api/admin`  
**Header:** `Authorization: Bearer <admin_token>` (Role: ADMIN Wajib)

### 10.1 Statistik Dashboard

```http
GET /api/admin/stats
```

**Response (200):**
```json
{
    "overview": {
        "totalOrders": 1250,
        "successOrders": 1180,
        "pendingOrders": 15,
        "successRate": "94.4%",
        "totalRevenueIdr": 125000000,
        "failedOrders": 23
    },
    "breakdown": {
        "status": [
            { "status": "SUCCESS", "_count": 1180 },
            { "status": "PENDING", "_count": 15 },
            { "status": "FAILED", "_count": 23 }
        ],
        "chain": [
            { "chain": "bsc", "_count": 800 },
            { "chain": "base", "_count": 350 },
            { "chain": "eth", "_count": 30 }
        ]
    },
    "calculatedAt": "2024-12-30T10:00:00Z",
    "cacheExpiresIn": 120
}
```

---

### 10.2 Data Pengguna

```http
GET /api/admin/users?page=0&limit=20&search=budi
```

---

### 10.3 Data Pesanan

```http
GET /api/admin/orders?page=0&limit=20&status=FAILED
```

---

### 10.4 CRUD Voucher

```http
# List
GET /api/admin/vouchers

# Create
POST /api/admin/vouchers
{
    "code": "NEWYEAR2025",
    "value": 25000,
    "minAmount": 100000,
    "maxUsage": 1000,
    "expiresAt": "2025-01-31",
    "userId": null
}

# Delete
DELETE /api/admin/vouchers/:id
```

---

### 10.5 Operasi Pesanan

```http
# Retry Order (Re-send token)
POST /api/admin/orders/:id/retry

# Mark Success Manual
POST /api/admin/orders/:id/mark-success
{
    "txHash": "0xabc123..."
}
```

---

### 10.6 Treasury Management

```http
POST /api/admin/treasury/withdraw
{
    "chain": "bsc",
    "toAddress": "0xColdWallet...",
    "amount": 10
}
```

---

### 10.7 Chain & Token Management

```http
# List Chains
GET /api/admin/chains

# Add Chain
POST /api/admin/chains
{
    "name": "Polygon",
    "slug": "polygon",
    "type": "EVM",
    "rpcUrl": "https://polygon-rpc.com",
    "chainId": 137,
    "privateKey": "xxx",
    "explorerUrl": "https://polygonscan.com"
}

# Update Chain
PATCH /api/admin/chains/:id
{
    "isActive": false
}

# List Tokens
GET /api/admin/tokens?chainId=xxx

# Add Token
POST /api/admin/tokens
{
    "chainId": "chain-uuid",
    "symbol": "MATIC",
    "name": "Polygon Native",
    "isNative": true,
    "decimals": 18,
    "markupPercent": 5
}

# Update Token
PATCH /api/admin/tokens/:id
{
    "isActive": true,
    "markupPercent": 6
}
```

---

## ❌ 11. ERROR HANDLING

### Standard Error Response
```json
{
    "error": "Error message in Bahasa Indonesia"
}
```

### HTTP Status Codes
| Code | Meaning | Action |
|------|---------|--------|
| 200 | Success | ✅ |
| 201 | Created | ✅ |
| 400 | Bad Request | Tampilkan error message |
| 401 | Unauthorized | Redirect ke Login |
| 403 | Forbidden | Tampilkan "Akses Ditolak" |
| 404 | Not Found | Tampilkan "Data Tidak Ditemukan" |
| 409 | Conflict | Handle specific case (e.g., pending order) |
| 429 | Rate Limited | Tampilkan cooldown timer |
| 500 | Server Error | Tampilkan "Coba lagi nanti" |

### Frontend Error Handler
```javascript
const handleApiError = async (response) => {
    if (response.status === 401) {
        localStorage.removeItem('token');
        router.push('/login');
        return;
    }
    
    if (response.status === 429) {
        showToast("Terlalu banyak request. Mohon tunggu sebentar.");
        return;
    }
    
    const data = await response.json();
    showToast(data.error || "Terjadi kesalahan");
};
```

---

## 🔄 12. FLOWCHART ALUR TRANSAKSI

```
┌─────────────────────────────────────────────────────────────┐
│                     ALUR PEMBELIAN TOKEN                    │
└─────────────────────────────────────────────────────────────┘

[1. Homepage]
     │
     ▼
[GET /api/pricing/quote] ──────► Check inventoryStatus
     │                                    │
     │ ◄─────── OUT_OF_STOCK ◄────────────┘
     │
     ▼
[2. Checkout Form]
     │
     ▼
[POST /api/orders] ── Error 409 ──► [Show Pending Order Modal]
     │
     │ Success
     ▼
[3. Payment Method Selection]
     │
     ▼
[POST /api/orders/:id/pay] { method: "QRIS" }
     │
     │ ┌─────── Response ───────┐
     │ │  qrImage (base64)      │
     │ │  paymentUrl            │
     │ │  expiryTime            │
     │ └────────────────────────┘
     ▼
[4. Payment Page]
     │
     ├── Display QR Image
     ├── Start countdown timer
     ├── Start polling POST /api/orders/:id/sync
     │
     ▼
[User pays via e-wallet]
     │
     ▼
[Midtrans Webhook] ──► [Backend: handlePaymentSuccess]
     │                         │
     │                         ▼
     │                  [Add to BullMQ Queue]
     │                         │
     ▼                         ▼
[Polling detects PAID/PROCESSING]
     │
     ▼
[5. Processing Page]
     │
     ├── Show "Token sedang dikirim..."
     ├── Continue polling
     │
     ▼
[Backend: processOrder] ──► Blockchain Transaction
     │
     ▼
[Order status: SUCCESS]
     │
     ▼
[6. Success Page]
     │
     ├── Show txHash
     ├── Link to blockchain explorer
     ├── Telegram notification sent
     │
     ▼
[DONE!]
```

---

## ✅ CHECKLIST INTEGRASI FRONTEND

- [ ] Setup environment variables (API_URL)
- [ ] Implement JWT token storage (localStorage/SecureStorage)
- [ ] Handle 401 errors → redirect to login
- [ ] Implement auth flow (register, login, google)
- [ ] Build order creation flow
- [ ] Implement payment polling
- [ ] Handle all order statuses in UI
- [ ] Show inventory status before checkout
- [ ] Implement referral share feature
- [ ] Build admin dashboard (if applicable)

---

**📞 Butuh Bantuan?**
- Admin: @Hanzbroww (Telegram)
- Email: support@kiosweb3.com

---

**© 2024 EceranStore - All Rights Reserved**
