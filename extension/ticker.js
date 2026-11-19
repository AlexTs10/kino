// A 1-second tick from a dedicated worker. Worker timers are not slowed down when the recorder window is hidden.
setInterval(() => postMessage(0), 1000);
