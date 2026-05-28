const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');
const pool = require('./db/index');
const { buildLandingContext } = require('./lib/landing-context');
const trackPageView = require('./lib/track-pageview');
const { requestLogger } = require('./lib/request-logger');

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('ERROR: SESSION_SECRET environment variable is required');
  process.exit(1);
}
// ADMIN_PASSWORD is OPTIONAL. The admin panel can be reached two ways:
//   1) A logged-in contractor whose contractors.is_admin = true (preferred).
//   2) The URL-key path (?key=<ADMIN_PASSWORD>) — only available when the env
//      var IS set. If ADMIN_PASSWORD is unset, path (2) is closed and only
//      contractor-session admins can reach /admin.
// See routes/admin.js requireAdmin() for the full gate logic.
if (!process.env.ADMIN_PASSWORD) {
  console.warn('Note: ADMIN_PASSWORD is unset. URL-key admin access (?key=…) is disabled; only logged-in admin contractors can reach /admin.');
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Login sessions are stored in the Postgres "session" table via
// connect-pg-simple. That means sessions survive server restarts and deploys
// (the previous in-memory store dropped everyone out on every deploy).
const isProd = process.env.NODE_ENV === 'production';

// Render sits a proxy in front of us. Without this line, Express thinks the
// connection is plain HTTP and refuses to send the "Secure" cookie back, which
// would silently log everyone out in production.
if (isProd) app.set('trust proxy', 1);

app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    pruneSessionInterval: 60 * 60   // garbage-collect expired sessions hourly
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    // Cookie config notes:
    //  - httpOnly: JavaScript on the page can't read it. Limits XSS damage.
    //  - sameSite: 'lax' — sent on normal navigations from our own pages but
    //    NOT on cross-site POSTs. This blocks most CSRF attacks for free and
    //    is the standard setting for a single-site app like this one.
    //  - secure: true in prod (HTTPS only). Required by browsers for sameSite
    //    cookies that work reliably. Locally we keep it off so http://localhost
    //    can still set the cookie.
    //  - maxAge: 7 days. After that, the contractor has to log in again.
    secure: isProd,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(trackPageView);

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Inject MAPBOX_TOKEN into HTML pages that use the map.
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || '';
const tokenScript = `<script>window.MAPBOX_TOKEN = ${JSON.stringify(MAPBOX_TOKEN)};</script>`;

function injectToken(req, res, filePath, extraScripts = '') {
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Error loading page');
    res.send(html.replace('</head>', tokenScript + extraScripts + '</head>'));
  });
}

// Load contractor context for scoped links (?c=<slug>)
app.get('/scope.html', async (req, res) => {
  const contractorSlug = req.query.c;
  let extraScripts = '';

  if (contractorSlug) {
    try {
      const { getContractorBySlug } = require('./db/contractors');
      const contractor = await getContractorBySlug(contractorSlug);
      if (contractor) {
        extraScripts = `<script>
          window.CONTRACTOR_SLUG = ${JSON.stringify(contractor.unique_slug)};
          window.CONTRACTOR_NAME = ${JSON.stringify(contractor.business_name)};
        </script>`;
      }
    } catch (err) {
      console.error('Failed to load contractor for scope.html:', err.message);
    }
  }

  injectToken(req, res, path.join(__dirname, 'public', 'scope.html'), extraScripts);
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Routes
app.use('/api/auth', requestLogger, require('./routes/auth'));
app.use('/api/contractors', require('./routes/contractors'));
app.use('/api/scope', require('./routes/scope'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/events', requestLogger, require('./routes/events'));
app.use('/api/territory', require('./routes/territory'));
app.use('/api/opportunities', require('./routes/opportunities'));
app.use('/api/ratings', require('./routes/ratings'));
app.use('/admin', require('./routes/admin'));
app.use('/api/admin', require('./routes/admin-metrics'));
const { router: foundingApiRouter, handleWelcomePage, handleSetPassword } = require('./routes/founding');
app.use('/api/founding', foundingApiRouter);

// Subscription billing — checkout, verify-on-return, webhook receiver.
// See docs/polsia-billing-integration.md for the Polsia-side contract.
const billingRouter = require('./routes/billing');
app.use('/api/billing', billingRouter);

// Pricing page — public tier table + founding spotlight
app.get('/pricing', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});

// Public territory ZIP availability checker — paste-in-DM conversion tool
app.get('/territory', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'territory.html'));
});

// Public example lead — shareable demo for outreach (no auth required)
app.get('/example', (req, res) => {
  injectToken(req, res, path.join(__dirname, 'public', 'example.html'));
});
app.get('/demo', (req, res) => {
  res.redirect(301, '/example');
});

// Login wall for the contractor dashboard. If there's no session attached to
// the request, send the visitor to the login page before the dashboard HTML
// ever loads. Doing this on the server (instead of letting the dashboard load
// and then redirect from JavaScript) avoids a flash of unauthenticated UI.
app.get('/contractor', (req, res) => {
  if (!req.session || !req.session.contractorId) {
    return res.redirect('/login');
  }
  injectToken(req, res, path.join(__dirname, 'public', 'contractor.html'));
});

app.get('/contractor/opportunities', (req, res) => {
  if (!req.session || !req.session.contractorId) {
    return res.redirect('/login');
  }
  injectToken(req, res, path.join(__dirname, 'public', 'opportunities.html'));
});

app.get('/api-docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'docs', 'index.html'));
});

app.get('/about', (_req, res) => {
  res.render('about');
});

app.get('/terms.html', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.get('/privacy.html', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// Homeowner rating page — /rate/<token>
app.get('/rate/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rate.html'));
});

app.get('/founding', (_req, res) => {
  res.render('founding');
});
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/signup', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/founding/welcome', handleWelcomePage);
app.get('/founding/set-password', handleSetPassword);

// Stripe redirects subscribers back here after checkout. The handler verifies
// the session via Polsia, updates contractor.plan, and forwards to /contractor.
app.get('/billing/welcome', billingRouter.handleBillingWelcome);

// This is the URL the contractor clicks from their "magic login" email.
// Flow: read the token from the URL → look it up in the database → start a
// new login session → mark the token used so it can't be clicked twice →
// redirect to /contractor (the browser carries the new login cookie).
// Any failure along the way sends them back to /login with an error message.
app.get('/auth/magic', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/login?error=link_invalid_or_expired');

  try {
    const { validateMagicLink, consumeMagicLink } = require('./db/magic-links');
    const link = await validateMagicLink(token);
    if (!link) return res.redirect('/login?error=link_invalid_or_expired');

    req.session.regenerate(async (regenErr) => {
      if (regenErr) {
        console.error('[auth/magic] regenerate error:', regenErr.message);
        return res.redirect('/login?error=link_invalid_or_expired');
      }
      try {
        // We mark the link "used" only AFTER successfully starting a new
        // session. If we burned the token first and then the session failed,
        // the contractor would be stuck — they'd have to request another link.
        await consumeMagicLink(link.link_id);
      } catch (consumeErr) {
        console.error('[auth/magic] consume error:', consumeErr.message);
        return res.redirect('/login?error=link_invalid_or_expired');
      }
      req.session.contractorId = link.contractor_id;
      req.session.contractorSlug = link.unique_slug;
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('[auth/magic] save error:', saveErr.message);
          return res.redirect('/login?error=link_invalid_or_expired');
        }
        res.redirect(303, '/contractor');
      });
    });
  } catch (err) {
    console.error('[auth/magic] error:', err.message);
    res.redirect('/login?error=link_invalid_or_expired');
  }
});

// Forgot password — serves login page with the forgot form auto-opened.
app.get('/forgot-password', (req, res) => {
  res.redirect('/login?forgot=1');
});

// Password reset page — validates token server-side before serving the form.
// If token is invalid/expired, redirects to /login with an error message.
app.get('/reset-password', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/login?error=reset_invalid');

  try {
    const { validateResetToken } = require('./db/password-reset');
    const link = await validateResetToken(token);
    if (!link) {
      return res.redirect('/login?error=reset_invalid');
    }
    // Serve the reset-password.html page; client-side JS will POST to /api/auth/reset-password
    res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
  } catch (err) {
    console.error('[reset-password] token validation error:', err.message);
    res.redirect('/login?error=reset_invalid');
  }
});

app.get('/', (_req, res) => {
  res.render('layout', buildLandingContext());
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});