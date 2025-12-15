require('dotenv').config();
const TaskRunner = require('./src/classes/TaskRunner');

// Manejo de señales para shutdown limpio
const bot = new TaskRunner();

process.on('SIGINT', async () => {
    console.log('\n🛑 Interrupción detectada. Cerrando...');
    bot.isRunning = false;
    await bot.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Terminación detectada. Cerrando...');
    bot.isRunning = false;
    await bot.shutdown();
    process.exit(0);
});

// Iniciar
console.log('🤖 Iniciando Travian Bot...');
console.log('   Presiona Ctrl+C para detener\n');

bot.start().catch(console.error);