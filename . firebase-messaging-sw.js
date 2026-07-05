// Service worker Firebase Cloud Messaging — ALCF Basket
// Nécessaire pour recevoir les notifications push quand le site n'est pas ouvert au premier plan.
// Doit rester à la racine du site (même niveau que index.html).

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyCYZuhh6iKsUMM-MBA3fANDGgCQOhANfVU",
    authDomain: "alcf-basket.firebaseapp.com",
    projectId: "alcf-basket",
    storageBucket: "alcf-basket.firebasestorage.app",
    messagingSenderId: "1082312491425",
    appId: "1:1082312491425:web:646f4c5158d2707b0d8be0"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || 'ALCF Basket';
    const options = {
        body: (payload.notification && payload.notification.body) || '',
        icon: 'logo-alcf.png',
        badge: 'logo-alcf.png'
    };
    self.registration.showNotification(title, options);
});
