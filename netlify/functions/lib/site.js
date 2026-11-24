// The address this deploy answers on.
//
//   siteUrl()        the site itself (what Netlify calls URL)
//   originOf(event)  where this request came in: the site, or one of its
//                    Netlify previews (deploy-preview-12--goldas-crm.netlify.app),
//                    so a preview sends people back to itself and calls its
//                    own functions. Any other host counts as the site.
const PROD = 'https://goldas-crm.netlify.app';
const OURS = /^([a-z0-9-]+--)?goldas-crm\.netlify\.app$/;

const siteUrl = (env = process.env) => (env.URL || PROD).replace(/\/$/, '');

function originOf(event, env = process.env) {
  const h = event?.headers || {};
  const host = String(h.host || h.Host || '').toLowerCase().trim();
  return OURS.test(host) ? `https://${host}` : siteUrl(env);
}

/** True for the site's own address or one of its previews (https only). */
const isOurOrigin = (origin) => /^https:\/\//.test(String(origin || '')) && OURS.test(String(origin).slice(8));

module.exports = { siteUrl, originOf, isOurOrigin, PROD };
