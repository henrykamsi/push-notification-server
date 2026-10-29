// sw.js - Service Worker for Sendly Push Notifications

self.addEventListener("install", function(event) {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function(event) {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function(event) {
    let data = {};
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data = {
                title: "Sendly Notification",
                body: event.data.text() || "You have a new notification"
            };
        }
    }

    const title = data.title || "Sendly Notification";
    const options = {
        body: data.body || "You have a new notification",
        icon: data.icon || "/icon.png",
        image: data.image || "",
        badge: "/badge.png",
        vibrate: [200, 100, 200],
        data: data.data || {},
        actions: data.actions || []
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener("notificationclick", function(event) {
    event.notification.close();

    const url = event.notification.data?.url || "/";
    const notificationId = event.notification.data?.notification_id;
    
    // 🔥 TRACK THE CLICK TO THE SERVER
    if (notificationId) {
        fetch('https://push-notification-server-5tx2.onrender.com/api/v1/analytics/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notification_id: notificationId, action: 'click' })
        }).catch(err => console.log('Tracking failed', err));
    }

    event.waitUntil(
        clients.openWindow(url)
    );
});
