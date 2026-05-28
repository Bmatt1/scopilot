/**
 * Owns: contractor authentication — signup, login, logout, magic-link passwordless login,
 * password reset (forgot-password + reset-password).
 * Does NOT own: homeowner accounts, admin panel.
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { createContractor, getContractorByEmail, generateSlug } = require('../db/contractors');
const { countRecentMagicLinks, createMagicLink, RATE_LIMIT_MAX } = require('../db/magic-links');
const { sendMagicLoginEmail, sendPasswordResetEmail } = require('../services/email');
const { createResetToken, validateResetToken, consumeResetToken } = require('../db/password-reset');
const { trackEvent } = require('../lib/track-pageview');
const { requireAuth } = require('../lib/require-auth');

const SALT_ROUNDS = 12;

// Helper for every "you just successfully logged in" moment.
// Issues a brand-new session ID, attaches the contractor to it, saves it, then
// calls back. The new-ID step matters: if an attacker somehow planted a session
// cookie in the user's browser before login, that cookie is now useless because
// we just replaced the ID. The technical name is "session regeneration."
function establishSession(req, contractor, cb) {
  req.session.regenerate((regenErr) => {
    if (regenErr) return cb(regenErr);
    req.session.contractorId = contractor.id;
    req.session.contractorSlug = contractor.unique_slug;
    // Cache the admin flag on the session so the /admin guards don't need
    // to hit the DB on every protected request. If is_admin changes in the
    // DB after login, the contractor needs to log out and back in for it
    // to take effect — acceptable trade-off for the request-rate savings.
    req.session.isAdmin = !!contractor.is_admin;
    req.session.save(cb);
  });
}

router.post('/signup', async (req, res) => {
  try {
    const { business_name, owner_name, email, password, trade_type, service_area } = req.body;

    if (!business_name || !owner_name || !email || !password || !trade_type) {
      return res.status(400).json({ error: 'business_name, owner_name, email, password, and trade_type are required' });
    }

    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await getContractorByEmail(email.toLowerCase().trim());
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const slug = generateSlug(business_name, trade_type);

    const contractor = await createContractor({
      business_name: business_name.trim(),
      owner_name: owner_name.trim(),
      email: email.toLowerCase().trim(),
      password_hash,
      phone: req.body.phone || '',
      trade_type,
      service_area: service_area || '',
      unique_slug: slug
    });

    establishSession(req, contractor, (sessErr) => {
      if (sessErr) {
        console.error('[auth/signup] session error:', sessErr.message);
        return res.status(500).json({ error: 'Signup succeeded but session creation failed. Please log in.' });
      }

      trackEvent({
        eventType: 'signup_completed',
        pageUrl: '/signup',
        contractorId: contractor.id,
        metadata: { trade_type }
      });

      res.json({ success: true, contractor: {
        id: contractor.id,
        business_name: contractor.business_name,
        owner_name: contractor.owner_name,
        email: contractor.email,
        trade_type: contractor.trade_type,
        service_area: contractor.service_area,
        unique_slug: contractor.unique_slug
      }});
    });
  } catch (err) {
    console.error('[auth/signup] error:', err.message);
    res.status(500).json({ error: 'Signup failed' });
  }
});

/**
 * POST /api/auth/login
 *
 * Two response styles based on who's calling:
 *  - A web browser submitting the sign-in form → we send back a redirect to
 *    /contractor. The login cookie goes out with the redirect, and the browser
 *    then loads /contractor already carrying it. Simple and reliable.
 *  - A JSON API client → we just return { success: true } and let the caller
 *    decide what to do next.
 */
router.post('/login', async (req, res) => {
  const wantsJson = req.is('application/json');
  const failResponse = (status, message) => {
    if (wantsJson) return res.status(status).json({ error: message });
    return res.redirect(303, '/login?error=invalid');
  };

  try {
    const { email, password } = req.body;
    if (!email || !password) return failResponse(400, 'email and password are required');

    const contractor = await getContractorByEmail(String(email).toLowerCase().trim());
    if (!contractor) return failResponse(401, 'Invalid email or password');

    const valid = await bcrypt.compare(password, contractor.password_hash);
    if (!valid) return failResponse(401, 'Invalid email or password');

    establishSession(req, contractor, (sessErr) => {
      if (sessErr) {
        console.error('[auth/login] session error:', sessErr.message);
        if (wantsJson) return res.status(500).json({ error: 'Login failed' });
        return res.redirect(303, '/login?error=login_failed');
      }

      trackEvent({
        eventType: 'login',
        pageUrl: '/login',
        contractorId: contractor.id,
        metadata: { method: 'password' }
      });

      if (wantsJson) return res.json({ success: true });
      return res.redirect(303, '/contractor');
    });
  } catch (err) {
    console.error('[auth/login] error:', err.message);
    if (wantsJson) return res.status(500).json({ error: 'Login failed' });
    return res.redirect(303, '/login?error=login_failed');
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    // No need to manually clear the cookie — express-session does that when we
    // destroy the session. Clearing it ourselves with slightly different
    // attributes used to leave behind a "ghost" cookie that confused later logins.
    res.json({ success: true });
  });
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { getContractorById } = require('../db/contractors');
    const contractor = await getContractorById(req.session.contractorId);
    if (!contractor) return res.status(404).json({ error: 'Not found' });
    res.json({ contractor });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

/**
 * POST /api/auth/magic-link
 *
 * Emails the contractor a one-click login link that works for 15 minutes.
 *
 * Two things to know:
 *  1. We always reply "if an account exists, you'll get a link" — even if no
 *     account matches the email. This stops attackers from probing for valid
 *     emails by watching for different responses.
 *  2. Rate-limited to 3 link requests per hour per contractor so a flood of
 *     "send me a link" presses doesn't spam the inbox.
 */
router.post('/magic-link', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const successResp = { success: true, message: "If an account exists for that email, you'll receive a login link shortly." };

    const contractor = await getContractorByEmail(normalizedEmail);
    if (!contractor) return res.json(successResp);

    const recentCount = await countRecentMagicLinks(contractor.id);
    if (recentCount >= RATE_LIMIT_MAX) return res.json(successResp);

    const token = await createMagicLink(contractor.id);
    const APP_URL = process.env.APP_URL || 'https://scopilot.polsia.app';
    const magicUrl = `${APP_URL}/auth/magic?token=${token}`;

    sendMagicLoginEmail({
      email: normalizedEmail,
      businessName: contractor.business_name,
      magicUrl
    }).catch(err => console.error('[auth/magic-link] email send error:', err.message));

    res.json(successResp);
  } catch (err) {
    console.error('[auth/magic-link] error:', err.message);
    res.status(500).json({ error: 'Failed to process request. Try again.' });
  }
});

/**
 * POST /api/auth/forgot-password
 *
 * Emails the contractor a password-reset link that works for 1 hour.
 * Same anti-probing pattern as magic-link: we always reply success, even when
 * no account matches, so the response can't be used to enumerate emails.
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const successResp = { success: true, message: 'If an account exists for that email, you will receive a password reset link shortly.' };

    const contractor = await getContractorByEmail(normalizedEmail);
    if (!contractor) return res.json(successResp);

    const token = await createResetToken(contractor.id);
    const APP_URL = process.env.APP_URL || 'https://scopilot.polsia.app';
    const resetUrl = `${APP_URL}/reset-password?token=${token}`;

    sendPasswordResetEmail({
      email: normalizedEmail,
      businessName: contractor.business_name,
      resetUrl
    }).catch(err => console.error('[auth/forgot-password] email send error:', err.message));

    res.json(successResp);
  } catch (err) {
    console.error('[auth/forgot-password] error:', err.message);
    res.status(500).json({ error: 'Failed to process request. Try again.' });
  }
});

/**
 * POST /api/auth/reset-password
 *
 * After the contractor clicks the reset link and types a new password, the
 * /reset-password form posts here. We verify the token, save the new password,
 * and log them in. The reset-password page then navigates to /contractor.
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'token and password are required' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const link = await validateResetToken(token);
    if (!link) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }

    const { updatePassword } = require('../db/contractors');
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    await updatePassword(link.contractor_id, password_hash);
    await consumeResetToken(link.token_id);

    establishSession(req, { id: link.contractor_id, unique_slug: link.unique_slug }, (sessErr) => {
      if (sessErr) {
        console.error('[auth/reset-password] session error:', sessErr.message);
        return res.status(500).json({ error: 'Session error. Please try logging in.' });
      }
      res.json({ success: true, redirectUrl: '/contractor' });
    });
  } catch (err) {
    console.error('[auth/reset-password] error:', err.message);
    res.status(500).json({ error: 'Failed to reset password. Please try again.' });
  }
});

module.exports = router;
module.exports.requireAuth = requireAuth;
