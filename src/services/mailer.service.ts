import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../libs/logger.js';

let transporter: nodemailer.Transporter;

export const initMailer = () => {
    if (env.SMTP_USER && env.SMTP_PASS) {
        transporter = nodemailer.createTransport({
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_PORT === 465, // true for 465, false for other ports
            auth: {
                user: env.SMTP_USER,
                pass: env.SMTP_PASS,
            },
        });

        logger.info('SMTP Mailer initialized');
    } else {
        logger.warn('SMTP credentials not provided. Mailer disabled (OTP will be logged only).');
    }
};

export const sendEmail = async (to: string, subject: string, html: string) => {
    if (!transporter) {
        logger.warn({ to, subject, body: html }, 'Mailer not configured. Simulating email send.');
        return;
    }

    try {
        const info = await transporter.sendMail({
            from: env.SMTP_FROM,
            to,
            subject,
            html,
        });

        logger.info({ messageId: info.messageId, to }, 'Email sent');
    } catch (error) {
        logger.error({ error, to }, 'Failed to send email');
        throw error;
    }
};

export const sendOtpEmail = async (to: string, otp: string) => {
    const subject = 'Kode OTP Anda - KiosWeb3';
    const html = `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
      <h2>Verifikasi OTP</h2>
      <p>Gunakan kode berikut untuk memverifikasi identitas Anda:</p>
      <h1 style="color: #4A90E2; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
      <p>Kode ini berlaku selama 5 menit.</p>
      <hr/>
      <p style="font-size: 12px; color: #777;">Jika Anda tidak merasa melakukan permintaan ini, abaikan saja.</p>
    </div>
  `;

    await sendEmail(to, subject, html);
};
