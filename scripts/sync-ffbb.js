/**
 * Synchronisation FFBB -> Firestore
 * ---------------------------------
 * Récupère le classement et les rencontres de la poule ALCF Basket
 * et les enregistre dans Firestore pour affichage sur le site.
 *
 * Deux sources sont utilisées :
 *  1. Scraping du site public competitions.ffbb.com (données complètes :
 *     salles, logos) — identique à la synchro locale du club.
 *  2. Si le scraping échoue, bascule sur l'API mobile api.ffbb.app.
 *
 * Exécuté automatiquement par GitHub Actions toutes les ~20 minutes.
 */

const admin = require('firebase-admin');

// Saison 2026/27 — Poule A (à modifier si le club change de poule)
const PHASE = '200000002897652';
const POULE_ID = '200000003055512';
const ALCF = 'FIRMINY CHAZEAU-FAYOL AL';

const SITE_BASE = 'https://competitions.ffbb.com/ligues/ara/competitions/pnm';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API_BASE = 'https://api.ffbb.app/';
const API_HEADERS = { 'user-agent': 'okhttp/4.12.0' };

// ---------- Outils communs ----------

function formatHeureHHMM(heure) {
  const digits = String(heure || '').replace(/\D/g, '');
  if (digits.length === 3) return `0${digits[0]}:${digits.slice(1)}`;
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  return '';
}

function teamName(e) {
  let nom = e?.nom || '';
  if (e?.numeroEquipe) nom += ` - ${e.numeroEquipe}`;
  return nom.trim();
}

function normalizeMatch(m, logoMap) {
  const dt = m.date_rencontre ? new Date(m.date_rencontre) : null;
  const nom1 = teamName(m.idEngagementEquipe1);
  const nom2 = teamName(m.idEngagementEquipe2);
  return {
    date: dt ? dt.toISOString().split('T')[0] : '',
    heure: formatHeureHHMM(dt),
    equipe1: nom1,
    equipe2: nom2,
    logo1: logoMap[nom1] || null,
    logo2: logoMap[nom2] || null,
    score1: m.joue ? parseInt(m.resultatEquipe1) : null,
    score2: m.joue ? parseInt(m.resultatEquipe2) : null,
    joue: !!m.joue,
    journee: m.numeroJournee || null,
    salle: m.lieuRencontre?.salle?.nom || m.salle?.libelle || '',
    ville: m.lieuRencontre?.adresse?.ville || m.salle?.cartographie?.adresse || '',
    source: 'ffbb-2026-27'
  };
}

function computeClassement(matchs) {
  const teams = {};
  for (const m of matchs) {
    for (const nom of [m.equipe1, m.equipe2]) {
      if (nom && !teams[nom]) teams[nom] = { nom, logo: m.logo1 || m.logo2 || null, joues: 0, gagnes: 0, perdus: 0, points: 0, diff: 0 };
    }
  }
  for (const m of matchs) {
    if (!m.joue) continue;
    const t1 = teams[m.equipe1];
    const t2 = teams[m.equipe2];
    if (!t1 || !t2) continue;
    const s1 = m.score1 || 0;
    const s2 = m.score2 || 0;
    t1.joues++; t2.joues++;
    t1.diff += (s1 - s2); t2.diff += (s2 - s1);
    if (s1 > s2) { t1.gagnes++; t2.perdus++; t1.points += 2; t2.points += 1; }
    else { t2.gagnes++; t1.perdus++; t2.points += 2; t1.points += 1; }
  }
  return Object.values(teams)
    .map(t => ({
      position: 0, equipe: t.nom, logo: t.logo,
      joues: t.joues, mj: t.joues, gagnes: t.gagnes, victoires: t.gagnes,
      perdus: t.perdus, defaites: t.perdus, difference: t.diff, points: t.points
    }))
    .sort((a, b) => b.points - a.points || b.difference - a.difference)
    .map((t, i) => ({ ...t, position: i + 1 }));
}

// ---------- Source 1 : scraping competitions.ffbb.com ----------

function extractJsonArray(html, key) {
  const searchKey = `\\"${key}\\":[`;
  const start = html.indexOf(searchKey);
  if (start === -1) return null;
  const contentStart = start + searchKey.length;
  let depth = 0, pos = contentStart;
  for (; pos < html.length; pos++) {
    const c = html[pos];
    if (c === '[') depth++;
    else if (c === ']') { if (depth === 0) break; depth--; }
  }
  const raw = html.substring(contentStart, pos);
  return JSON.parse(`[${raw.replace(/\\"/g, '"')}]`);
}

async function scrapeFromSite() {
  const resp = await fetch(`${SITE_BASE}?phase=${PHASE}&poule=${POULE_ID}`, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`Scraping HTTP ${resp.status}`);
  const html = await resp.text();

  const ffbbMatchs = extractJsonArray(html, 'rencontres');
  if (!ffbbMatchs) throw new Error('Impossible d\'extraire les rencontres');

  const logoMap = {};
  for (const m of ffbbMatchs) {
    for (const e of [m.idEngagementEquipe1, m.idEngagementEquipe2]) {
      const nom = teamName(e);
      const logoId = e?.idOrganisme?.logo?.id;
      if (nom && logoId && !logoMap[nom]) {
        logoMap[nom] = `https://api.ffbb.com/assets/${logoId}?height=60&fit=contain&format=png`;
      }
    }
  }

  return ffbbMatchs.map(m => normalizeMatch(m, logoMap));
}

// ---------- Source 2 : API api.ffbb.app (secours) ----------

async function getApiToken() {
  const res = await fetch(`${API_BASE}items/configuration`, { headers: API_HEADERS });
  if (!res.ok) throw new Error(`Erreur configuration FFBB : HTTP ${res.status}`);
  const json = await res.json();
  const token = json?.data?.key_dh;
  if (!token) throw new Error('Jeton API FFBB introuvable');
  return token;
}

async function fetchFromApi() {
  const apiToken = await getApiToken();
  const headers = { ...API_HEADERS, Authorization: `Bearer ${apiToken}` };

  const fields = [
    'id', 'date_rencontre', 'horaire', 'numeroJournee',
    'nomEquipe1', 'nomEquipe2', 'resultatEquipe1', 'resultatEquipe2', 'joue'
  ].join(',');
  const filter = encodeURIComponent(JSON.stringify({ idPoule: { _eq: Number(POULE_ID) } }));
  const url = `${API_BASE}items/ffbbserver_rencontres?fields=${encodeURIComponent(fields)}&filter=${filter}&sort=date_rencontre&limit=300`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Erreur rencontres FFBB : HTTP ${res.status}`);
  const json = await res.json();

  return (json.data || []).map(m => ({
    date: String(m.date_rencontre || '').slice(0, 10),
    heure: formatHeureHHMM(m.horaire),
    equipe1: m.nomEquipe1 || '',
    equipe2: m.nomEquipe2 || '',
    logo1: null,
    logo2: null,
    score1: m.resultatEquipe1 != null ? parseInt(m.resultatEquipe1) : null,
    score2: m.resultatEquipe2 != null ? parseInt(m.resultatEquipe2) : null,
    joue: !!m.joue,
    journee: m.numeroJournee ?? null,
    salle: '',
    ville: '',
    source: 'ffbb-2026-27'
  }));
}

// ---------- Écriture Firestore ----------

async function writeAll(db, matchs, classement) {
  const alcfMatchs = matchs
    .filter(m => m.equipe1 === ALCF || m.equipe2 === ALCF)
    .map(m => {
      const isHome = m.equipe1 === ALCF;
      return { ...m, adversaire: isHome ? m.equipe2 : m.equipe1, lieu: isHome ? 'Domicile' : 'Extérieur' };
    });

  const classementSnap = await db.collection('classement').get();
  const b1 = db.batch();
  classementSnap.forEach(doc => b1.delete(doc.ref));
  for (const t of classement) b1.set(db.collection('classement').doc(), t);
  await b1.commit();

  const matchsSnap = await db.collection('matchs').get();
  const b2 = db.batch();
  matchsSnap.forEach(doc => b2.delete(doc.ref));
  for (const m of alcfMatchs) b2.set(db.collection('matchs').doc(), m);
  await b2.commit();

  const updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await Promise.all([
    db.collection('ffbb').doc('poule').set({ nom: 'Poule A', classement, updatedAt, source: 'ffbb-2026-27' }),
    db.collection('ffbb').doc('rencontres').set({ matchs, updatedAt, source: 'ffbb-2026-27' })
  ]);

  return alcfMatchs.length;
}

async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('Variable FIREBASE_SERVICE_ACCOUNT manquante');
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  let matchs;
  try {
    console.log('Scraping competitions.ffbb.com...');
    matchs = await scrapeFromSite();
    console.log(`Scraping OK — ${matchs.length} rencontres`);
  } catch (e) {
    console.log(`Scraping échoué (${e.message}), bascule sur api.ffbb.app...`);
    matchs = await fetchFromApi();
    console.log(`API OK — ${matchs.length} rencontres`);
  }

  const classement = computeClassement(matchs);
  const nbAlcf = await writeAll(db, matchs, classement);

  console.log(`OK — ${classement.length} équipes au classement, ${matchs.length} rencontres poule, ${nbAlcf} match(s) ALCF.`);
}

main().catch(err => {
  console.error('Échec de la synchronisation FFBB :', err);
  process.exit(1);
});
