/**
 * Añade aldeas a una lista de vacas existente (por defecto: "raid")
 * Filtros: habitantes < 50 y distancia < 20 (desde el centro detectado o env)
 *
 * Uso:
 *   npm run farm-setup
 *
 * Variables opcionales (.env):
 *   FARM_LIST_NAME=raid
 *   FARM_MAX_POP=50
 *   FARM_MAX_DIST=20
 *   FARM_T1=2
 *   FARM_MAX_TARGETS=100
 *   FARM_CENTER_X=-81
 *   FARM_CENTER_Y=71
 *   FARM_RALLY_SLOT=39
 */

require('dotenv').config();
const GameClient = require('../classes/GameClient');

function toInt(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

async function main() {
    const client = new GameClient();
    await client.init();

    try {
        await client.login();

        const listName = process.env.FARM_LIST_NAME || 'raid';
        const maxPopulation = toInt(process.env.FARM_MAX_POP, 50);
        const maxDistance = toInt(process.env.FARM_MAX_DIST, 20);
        const maxTargets = toInt(process.env.FARM_MAX_TARGETS, 100);
        const t1 = toInt(process.env.FARM_T1, 2);

        const centerX = process.env.FARM_CENTER_X ? toInt(process.env.FARM_CENTER_X, null) : null;
        const centerY = process.env.FARM_CENTER_Y ? toInt(process.env.FARM_CENTER_Y, null) : null;
        const rallySlot = process.env.FARM_RALLY_SLOT ? toInt(process.env.FARM_RALLY_SLOT, null) : null;

        const result = await client.updateFarmListFromNearbyVillages({
            listName,
            maxPopulation,
            maxDistance,
            maxTargets,
            troopCounts: { t1 },
            addMethod: 'map',
            centerX: typeof centerX === 'number' ? centerX : undefined,
            centerY: typeof centerY === 'number' ? centerY : undefined,
            rallySlot: typeof rallySlot === 'number' ? rallySlot : undefined
        });

        console.log('\n==== FARM SETUP ===='); // Mantener ASCII para evitar problemas de encoding
        console.log(`Lista: ${result.listName}`);
        console.log(`Centro: (${result.center.x}|${result.center.y}) [${result.center.source}]`);
        console.log(`Filtro: hab < ${result.maxPopulation}, dist < ${result.maxDistance}`);
        console.log(`Tropas: t1=${result.troopCounts.t1}`);
        console.log(`Anadidos: ${result.addedCount}`);

        if (result.addedCount === 0) {
            console.log('No se anadio ningun objetivo (o ya estaban en la lista).');
        }
    } catch (error) {
        console.error('Error:', error.message);
        try { await client.screenshot('farm-setup-error.png'); } catch (e) {}
        process.exitCode = 1;
    } finally {
        await client.close();
    }
}

if (require.main === module) {
    main();
}

module.exports = main;
