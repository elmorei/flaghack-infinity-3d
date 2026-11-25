# Browser-hosted multiplayer preview

This branch adds an experimental direct connection mode to the existing web build. A player explicitly starts the host in their browser. A PC is preferred; a phone can volunteer, so every seat can be played from a phone. All players use the same game rules and must open the same preview build.

## Try it on one Wi-Fi network

Serve the preview web build over HTTPS to both devices. Add `?browser-host=1` to the game URL (or `&browser-host=1` if the URL already has a query). Open **Browser multiplayer (preview)** from the title screen:

1. On the host device, enter your handle, select **Start browser host**, then **Create invite**. Send the offer code privately to one guest.
2. On the guest device, enter your handle, paste that code into **Offer code**, and select **Create answer**. Send the answer code privately back to the host; keep the game tab open.
3. On the host, paste it into **Answer code** and select **Connect guest**. Wait for the guest to join the lobby; an open direct connection is not yet a lobby join. If the attempt expires or fails, create a fresh invite. Repeat with a fresh offer for each guest. Close the host setup panel to use the normal lobby.
4. To reconnect a guest to a still-running host, use a fresh invite and the same browser tab, which holds the seat-reclaim token.

**Manage browser burn** on the host provides manual pause and resume while the host tab stays alive. Keep that tab foregrounded and the device awake. There is no automatic host choice, handoff, durable checkpoint, matchmaking, or relay. Camp claims made during a pause can be retried after the host resumes. Closing or reloading the host ends the match. Direct connectivity depends on the devices and network; this is not an internet or cellular play guarantee. The standard Windows host path remains available.

Phone hosting runs the same simulation and update cadence. Before lowering fidelity, measure real-device performance, including several players, a late-game rejoin, and backgrounding or locking the host phone.
