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
 *   FARM_MIN_DIST=0
 *   FARM_T1=2
 *   FARM_MAX_TARGETS=100
 *   FARM_TOTAL_TARGETS=200
 *   FARM_AUTO_NEXT_LIST=true
 *   FARM_MAX_LISTS=20
 *   FARM_SOURCE=inactivesearch|map
 *   FARM_INACTIVESEARCH_URL=https://www.inactivesearch.it/inactives/ts31.x3.europe.travian.com?c=%28-77%7C-70%29
 *   FARM_INACTIVESEARCH_MAX_PAGES=30
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
        const maxTargets = toInt(process.env.FARM_MAX_TARGETS, 100);
        const t1 = toInt(process.env.FARM_T1, 2);

        const inactiveSearchUrl = (process.env.FARM_INACTIVESEARCH_URL || '').trim() || null;
        const source = (process.env.FARM_SOURCE || (inactiveSearchUrl ? 'inactivesearch' : 'map')).trim().toLowerCase();

        const autoNextList = (process.env.FARM_AUTO_NEXT_LIST || '').trim().toLowerCase() === 'true';
        const totalTargets = toInt(process.env.FARM_TOTAL_TARGETS, maxTargets);
        const maxLists = toInt(process.env.FARM_MAX_LISTS, 20);
        const useMulti = autoNextList || totalTargets > maxTargets;

        const maxDistance = toInt(process.env.FARM_MAX_DIST, 20);
        const minDistance = toInt(process.env.FARM_MIN_DIST, 0);
        const maxPopulationFromEnv = (process.env.FARM_MAX_POP || '').trim();
        const maxPopulation = maxPopulationFromEnv ? toInt(maxPopulationFromEnv, 50) : (source === 'map' ? 50 : undefined);

        const centerX = process.env.FARM_CENTER_X ? toInt(process.env.FARM_CENTER_X, null) : null;
        const centerY = process.env.FARM_CENTER_Y ? toInt(process.env.FARM_CENTER_Y, null) : null;
        const rallySlot = process.env.FARM_RALLY_SLOT ? toInt(process.env.FARM_RALLY_SLOT, null) : null;

        let result;

        if (source === 'inactivesearch') {
            const inactiveSearchMaxPages = toInt(process.env.FARM_INACTIVESEARCH_MAX_PAGES, 30);
            if (useMulti) {
                result = await client.updateFarmListsFromInactiveSearch({
                    listName,
                    maxTargetsPerList: maxTargets,
                    totalTargets,
                    maxLists,
                    troopCounts: { t1 },
                    inactiveSearchUrl,
                    inactiveSearchMaxPages,
                    maxPopulation,
                    maxDistance,
                    minDistance,
                    centerX: typeof centerX === 'number' ? centerX : undefined,
                    centerY: typeof centerY === 'number' ? centerY : undefined,
                    rallySlot: typeof rallySlot === 'number' ? rallySlot : undefined
                });
            } else {
                result = await client.updateFarmListFromInactiveSearch({
                    listName,
                    maxTargets,
                    troopCounts: { t1 },
                    inactiveSearchUrl,
                    inactiveSearchMaxPages,
                    maxPopulation,
                    maxDistance,
                    minDistance,
                    centerX: typeof centerX === 'number' ? centerX : undefined,
                    centerY: typeof centerY === 'number' ? centerY : undefined,
                    rallySlot: typeof rallySlot === 'number' ? rallySlot : undefined
                });
            }
        } else {
            if (useMulti) {
                result = await client.updateFarmListsFromNearbyVillages({
                    listName,
                    maxPopulation,
                    maxDistance,
                    maxTargetsPerList: maxTargets,
                    totalTargets,
                    maxLists,
                    troopCounts: { t1 },
                    addMethod: 'map',
                    centerX: typeof centerX === 'number' ? centerX : undefined,
                    centerY: typeof centerY === 'number' ? centerY : undefined,
                    rallySlot: typeof rallySlot === 'number' ? rallySlot : undefined
                });
            } else {
                result = await client.updateFarmListFromNearbyVillages({
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
            }
        }

        console.log('\n==== FARM SETUP ===='); // Mantener ASCII para evitar problemas de encoding
        console.log(`Lista: ${result.listName}`);
        console.log(`Centro: (${result.center.x}|${result.center.y}) [${result.center.source}]`);
        if (source === 'map') {
            console.log(`Filtro: hab < ${result.maxPopulation}, dist ${result.minDistance || 0}-${result.maxDistance}`);
        } else if (maxPopulation) {
            console.log(`Filtro: hab < ${maxPopulation} (verificado en mapa), dist ${minDistance}-${maxDistance}`);
        } else {
            console.log(`Filtro: InactiveSearch, dist ${minDistance}-${maxDistance}`);
        }
        console.log(`Tropas: t1=${result.troopCounts.t1}`);
        console.log(`Anadidos: ${result.addedCount}`);
        if (result.totalTargets) console.log(`Objetivo total: ${result.totalTargets}`);
        if (result.lists) console.log(`Listas tocadas: ${result.lists.length}`);

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
