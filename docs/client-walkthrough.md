# Browser client walkthrough

Open <http://127.0.0.1:4103>. This sequence uses the actual local demo forms and the A→B circulation accepted by `tests/circulation.test.ts`. The test provides exact operation quantities and tick counts; the browser UI has not been manually tested as part of this documentation checkpoint.

## Log in and authorize both Territories

1. In **Test authority, Home and Registry**, enter credentials in all three password fields: `demo-authority-admin`, `demo-policy-admin`, and `demo-sim-admin` (or the values set in the three `DEMO_*_ADMIN_SECRET` environment variables).
2. Click **Explicit test-authority login · issue native token**. This returns a native token to the page's in-memory field; it is not persisted by the browser.
3. For **Resource Actor URI**, enter Territory A's Actor URI, `http://127.0.0.1:4101/actors/territory`, then click **Request token digest**. Repeat with Territory B's Actor URI, `http://127.0.0.1:4102/actors/territory`. Home queues and signs a separate digest delivery for each Resource Server; the running launcher workers deliver them.
4. To inspect an authenticated resource, use **Actor and Territory resources** and the built-in retrieval controls, or select **Direct** / **Home proxy** in **Authenticated GET**. Protected B resources require its own digest to have arrived. A public-port visibility depends on its current admission policy.

The native token is memory-only. Reloading the page clears the token and administrator fields. If the token is rotated, log in to obtain the new native token and request fresh digests for both Resource Actor URIs; access depends on updated digest delivery.

## Territory A: produce and load cargo

1. In **Territory A · Policy rules**, leave the default policy and admission settings in place. Default policy permits mining, with a 20-unit quota and 100-unit ore reserve; `ore-to-metal` consumes 2 ore for 1 metal.
2. Click **Mine ore** with the default count `2`. The immediate operation creates 2 ore.
3. Click **Manufacture ore-to-metal** with count `1`. It consumes both ore and creates 1 metal.
4. Keep transfer direction **Warehouse to port**, the prefilled A metal Variety URI, and count `1`; click **Transfer inventory**.
5. In Registry destination choose **Territory A · Policy**. The destination Actor, first port and first route are populated from the selected Territory. Click **Send Registry entry request**, then use A's **Load vessel** with the prefilled vessel, metal URI and count `1`.
6. Click **Send Registry departure request**. The Registry state and ExitEvent list refresh; use the ExitEvent link/URI in **Fetch and verify ExitEvent** to inspect signed evidence. This test path's A exit carries 1 metal.

## Territory B: unload, reprocess, reload and exit

1. Choose **Territory B · Simulation** in the Registry destination selector and click **Send Registry entry request**. The request carries the previous A ExitEvent reference and matching manifest. Copy/select the current B EntryRequest URI shown in Registry state into B's `EntryRequest URI` field as needed; B load/unload forms use that request ID, not a vessel URI.
2. In B's facility panel click **Advance one tick** to complete berthing. Set the Cargo manifest to `{"entries":[{"variety":"<A metal Variety URI>","count":1,"data":{}}]}` using A's actual metal URI (the A-side ExitEvent/Registry state exposes it). Set handling duration to `2`, then click **Schedule unload**.
3. Click **Advance one tick** once: the one-of-two-tick unload is still incomplete and imported stock has not appeared. Click it a second time: B raw stock now contains one Stack of A metal.
4. Select **Imported A metal to refined**, count `1`; click **Start manufacture**. The input is reserved immediately. Advance **two ticks**; one refined product appears when the job completes.
5. Set the manifest to one Stack of B's refined Variety, count `1`, data `{}`; set handling duration to `1`; click **Schedule load**, then advance one tick. B's vessel cargo now contains the refined output.
6. Click **Send Registry departure request** with B selected; advance one B tick to complete departure processing. Inspect the new ExitEvent in Registry state and submit its URI to the evidence form.

The test's complete A→B sequence is: A mines 2 ore and makes 1 metal; B waits 1 berth tick, unloads the 1 imported metal over 2 ticks, consumes it to make 1 refined output over 2 ticks, and reloads that output over 1 tick. B departure advances 1 tick. The test then separately demonstrates B-native mining for 2 ticks and native manufacture for 2 ticks. Scheduled browser actions report jobs; use ticks and refresh controls to observe completion. A Territory's cargo, B Territory's cargo and Registry-declared cargo are separate states; Registry adoption can be toggled and cargo comparisons are descriptive.

For the exact HTTP assertions, including non-adoption and mismatch checkpoints, see `tests/circulation.test.ts` and `docs/handoffs/circulation.md`.
