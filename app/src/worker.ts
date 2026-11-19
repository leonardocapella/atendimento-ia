// F0: processo do worker existe no compose; filas, sweeper de timers e SLA entram no F1 (T4/T5).
console.log('worker: aguardando F1');
setInterval(() => {}, 1 << 30);
