async function runAttack() {
    console.log("🚨 STARTING ATTACK TEST 🚨");
    console.log("Sending 105 fake API keys to trigger the Crack Signal...\n");

    for (let i = 1; i <= 105; i++) {
        let fakeKey = "sendly_live_hacker_" + i;
        
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
            
            if (i % 10 === 0 || i === 1) {
                console.log(`Attempt ${i}: Server responded with ${res.status}`);
            }
            
        } catch (e) {
            console.log(`Attempt ${i}: Network error.`);
        }
    }
    
    console.log("\n✅ Attack finished. Check your Render logs to see what happened.");
}
runAttack();
