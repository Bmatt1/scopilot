/**
 * Owns: contractor session gate for protected API routes.
 * Returns 401 JSON when no contractor is bound to the current session.
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.contractorId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

module.exports = { requireAuth };
