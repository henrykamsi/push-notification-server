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
    
    // Get the data we sent from the server
    const data = event.notification.data || {};
    const action = event.action;
    
    // Default URL is the website URL (or the first button if no website URL is set)
    let targetUrl = data.url || "/";

    // 🛠️ BUTTON LOGIC: If they clicked a specific button, use that button's URL
    if (action === "button1" && data.button1_url) {
        targetUrl = data.button1_url;
    } else if (action === "button2" && data.button2_url) {
        targetUrl = data.button2_url;
    }

    // 🔥 TRACK THE CLICK TO THE SERVER
    const notificationId = data.notification_id;
    if (notificationId) {
        event.waitUntil(
            fetch('https://push-notification-server-5tx2.onrender.com/api/v1/analytics/track', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notification_id: notificationId, action: 'click' })
            }).catch(err => console.log('Tracking failed', err))
        );
    }

    // Open the correct link
    event.waitUntil(clients.openWindow(targetUrl));
});
