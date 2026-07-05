/**
 * Envoi des notifications — ALCF Basket
 * -------------------------------------
 * Envoie une alerte (notification push + e-mail) pour :
 *  1) chaque nouveau message reçu dans la messagerie interne du site
 *  2) chaque nouveau match ALCF ajouté au calendrier (publication FFBB)
 *
 * Exécuté automatiquement par GitHub Actions juste après la synchronisation FFBB,
 * donc avec un délai maximum d'environ 20 minutes après l'événement réel.
 *
 * Aucun coût : les notifications push utilisent Firebase Cloud Messaging (gratuit),
 * et les e-mails sont envoyés via un compte Gmail existant (mot de passe d'application).
 */

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const GMAIL_FROM = 'polocezar@gmail.com';

function isAlcfName(nomEquipe) {
    return (nomEquipe || '').toUpperCase().includes('CHAZEAU');
}

async function main() {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        throw new Error('Variable FIREBASE_SERVICE_ACCOUNT manquante');
    }
    if (!process.env.GMAIL_APP_PASSWORD) {
        throw new Error('Variable GMAIL_APP_PASSWORD manquante');
    }

    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    const db = admin.firestore();
    const messaging = admin.messaging();

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: GMAIL_FROM, pass: process.env.GMAIL_APP_PASSWORD }
    });

    // ---- État de la dernière exécution (évite les doublons entre deux passages du robot) ----
    const stateRef = db.collection('notifState').doc('state');
    const stateSnap = await stateRef.get();
    const state = stateSnap.exists ? stateSnap.data() : {};
    const isFirstRun = !stateSnap.exists;
    const lastMessageCheck = state.lastMessageCheck && state.lastMessageCheck.toDate
        ? state.lastMessageCheck.toDate()
        : new Date(0);
    const notifiedMatchIds = new Set(state.notifiedMatchIds || []);

    // ---- Membres approuvés (destinataires potentiels) ----
    const usersSnap = await db.collection('users').where('status', '==', 'approved').get();
    const usersById = {};
    usersSnap.docs.forEach(d => { usersById[d.id] = { id: d.id, ...d.data() }; });

    async function notifyUser(user, title, body) {
        const tasks = [];

        if (Array.isArray(user.fcmTokens) && user.fcmTokens.length > 0) {
            tasks.push(
                messaging.sendEachForMulticast({
                    tokens: user.fcmTokens,
                    notification: { title, body }
                }).catch(e => console.error('Erreur notification push pour', user.email, '-', e.message))
            );
        }

        if (user.email) {
            tasks.push(
                transporter.sendMail({
                    from: `"ALCF Basket" <${GMAIL_FROM}>`,
                    to: user.email,
                    subject: title,
                    text: body
                }).catch(e => console.error('Erreur e-mail pour', user.email, '-', e.message))
            );
        }

        await Promise.all(tasks);
    }

    // ---- 1) Nouveaux messages internes ----
    let newMessagesCount = 0;
    if (!isFirstRun) {
        const msgsSnap = await db.collection('messages')
            .where('createdAt', '>', lastMessageCheck)
            .get();

        for (const doc of msgsSnap.docs) {
            const m = doc.data();
            const recipients = m.to || [];
            for (const uid of recipients) {
                const user = usersById[uid];
                if (!user) continue;
                await notifyUser(
                    user,
                    `Nouveau message de ${m.fromNom || 'un membre'}`,
                    m.texte || ''
                );
                newMessagesCount++;
            }
        }
    }

    // ---- 2) Nouveaux matchs ALCF (publiés par la FFBB) ----
    let newMatchesCount = 0;
    const rencontresDoc = await db.collection('ffbb').doc('rencontres').get();
    const matchs = rencontresDoc.exists ? (rencontresDoc.data().matchs || []) : [];
    const matchsAlcf = matchs.filter(m => isAlcfName(m.equipe1) || isAlcfName(m.equipe2));

    if (!isFirstRun) {
        for (const m of matchsAlcf) {
            if (!m.id || notifiedMatchIds.has(m.id)) continue;

            const adversaire = isAlcfName(m.equipe1) ? m.equipe2 : m.equipe1;
            const title = 'Nouveau match ALCF programmé';
            const body = `${m.date || 'Date à confirmer'} ${m.heure || ''} — ALCF vs ${adversaire || 'adversaire à confirmer'}`.trim();

            for (const uid of Object.keys(usersById)) {
                await notifyUser(usersById[uid], title, body);
            }

            newMatchesCount++;
            notifiedMatchIds.add(m.id);
        }
    } else {
        // Premier lancement : on mémorise les matchs déjà connus sans spammer tout le monde
        matchsAlcf.forEach(m => { if (m.id) notifiedMatchIds.add(m.id); });
    }

    // ---- Sauvegarde de l'état pour la prochaine exécution ----
    await stateRef.set({
        lastMessageCheck: admin.firestore.FieldValue.serverTimestamp(),
        notifiedMatchIds: Array.from(notifiedMatchIds)
    });

    console.log(
        `OK — ${newMessagesCount} alerte(s) message envoyée(s), ${newMatchesCount} alerte(s) nouveau match envoyée(s).` +
        (isFirstRun ? ' (premier lancement : initialisation sans envoi de notifications)' : '')
    );
}

main().catch(err => {
    console.error('Échec de l\'envoi des notifications :', err);
    process.exit(1);
});
