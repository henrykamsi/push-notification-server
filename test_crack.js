async function runTest() {
    console.log("🚨 STARTING CRACK SIGNAL TEST 🚨");
    console.log("Sending 5 fake API keys to the server...\n");

    // We loop 5 times to send fake keys
    for (let i = 1; i <= 5; i++) {
        let fakeKey = "sendly_live_fake_" + Math.random().toString(36).substring(7);
        
        try {
            let res = await fetch('https://push-notification-server-5tx2.onrender.com/api/v1/send', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json', 
                    'x-sendly-key': fakeKey 
                },
                body: JSON.stringify({ 
                    channel: 'push', 
                    title: 'Hack Attempt', 
                    message: 'Trying to break in' 
                })
            });
            
            let data = await res.json();
            console.log(`Attempt ${i}: Sent fake key... Server responded: ${res.status} - ${data.message || data.error}`);
            
        } catch (e) {
            console.log(`Attempt ${i}: Network error.`);
        }
    }
    
    console.log("\n✅ Test finished. Go to your dashboard Settings and check the 'Crack Signals' number.");
}
runTest();
