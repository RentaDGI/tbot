/**
 * Lista aldeas detectadas en la UI (id=newdid + nombre)
 * Uso:
 *   node src/scripts/listVillages.js
 */

require('dotenv').config();
const GameClient = require('../classes/GameClient');

async function main() {
    const client = new GameClient();
    await client.init();

    try {
        await client.login();
        const villages = await client.getVillages();

        console.log('\n==== VILLAGES ====');
        if (!villages.length) {
            console.log('No se detectaron aldeas. Abre el juego manualmente y revisa el listado de aldeas.');
            return;
        }

        for (const v of villages) {
            console.log(`- ${v.id}  ${v.name}`);
        }

        console.log('\nUsa este id como village_id (newdid) en las tareas de construccion.');
    } catch (error) {
        console.error('Error:', error.message);
        process.exitCode = 1;
    } finally {
        await client.close();
    }
}

if (require.main === module) {
    main();
}

module.exports = main;

