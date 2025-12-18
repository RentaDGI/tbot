/**
 * Menú interactivo para añadir tareas de construcción
 * Uso: npm run add
 */

require('dotenv').config();
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

function normalizeVillageId(raw) {
    const cleaned = (raw || '').toString().trim();
    if (!cleaned) return 'main';
    if (cleaned.toLowerCase() === 'main') return 'main';
    const digitsOnly = cleaned.replace(/[^\d]/g, '');
    return digitsOnly || cleaned;
}

// Tipos de recursos
const RESOURCE_TYPES = {
    '1': { type: 'wood', name: 'Leñador', emoji: '🪵' },
    '2': { type: 'clay', name: 'Barrera', emoji: '🧱' },
    '3': { type: 'iron', name: 'Mina', emoji: '⛏️' },
    '4': { type: 'crop', name: 'Granja', emoji: '🌾' }
};

// Edificios comunes
const COMMON_BUILDINGS = {
    '1': { name: 'Edificio Principal', defaultSlot: 26 },
    '2': { name: 'Almacén', defaultSlot: 33 },
    '3': { name: 'Granero', defaultSlot: 34 },
    '4': { name: 'Cuartel', defaultSlot: 19 },
    '5': { name: 'Academia', defaultSlot: 22 },
    '6': { name: 'Herrería', defaultSlot: 20 },
    '7': { name: 'Mercado', defaultSlot: 28 },
    '8': { name: 'Embajada', defaultSlot: 25 },
    '9': { name: 'Escondite', defaultSlot: 23 },
    '10': { name: 'Muralla', defaultSlot: 40 }
};

async function main() {
    console.clear();
    console.log('═══════════════════════════════════════════');
    console.log('   🏗️  AÑADIR TAREAS DE CONSTRUCCIÓN');
    console.log('═══════════════════════════════════════════\n');

    const { data: account } = await supabase
        .from('accounts')
        .select('id, village_scan')
        .eq('username', process.env.GAME_USERNAME)
        .single();

    if (!account) {
        console.log('❌ Cuenta no encontrada. Ejecuta: npm start primero');
        rl.close();
        return;
    }

    await showCurrentTasks(account.id);

    while (true) {
        console.log('\n¿Qué quieres hacer?\n');
        console.log('   1. 🌾 Añadir tareas de RECURSOS');
        console.log('   2. 🏛️  Añadir tarea de EDIFICIO');
        console.log('   3. 📋 Ver tareas pendientes');
        console.log('   4. 🗑️  Borrar todas las tareas');
        console.log('   0. ❌ Salir\n');

        const choice = await question('Elige opción: ');

        switch (choice.trim()) {
            case '1':
                await addResourceTask(account.id);
                break;
            case '2':
                await addBuildingTask(account.id, account.village_scan);
                break;
            case '3':
                await showCurrentTasks(account.id);
                break;
            case '4':
                await clearTasks(account.id);
                break;
            case '0':
                console.log('\n👋 ¡Hasta luego!\n');
                rl.close();
                return;
            default:
                console.log('❌ Opción no válida');
        }
    }
}

async function addResourceTask(accountId) {
    console.log('\n═══════════════════════════════════════════');
    console.log('   🌾 TAREAS DE RECURSOS');
    console.log('═══════════════════════════════════════════\n');

    console.log('¿Qué quieres subir?\n');
    Object.entries(RESOURCE_TYPES).forEach(([key, val]) => {
        console.log(`   ${key}. ${val.emoji} Solo ${val.name}`);
    });
    console.log('   5. 🌟 TODOS LOS RECURSOS (Madera + Barro + Hierro + Cereal)');
    console.log('   -------------------');
    console.log('   6. ⚖️  BALANCEADO (Igual que opción 5)');
    console.log('   0. ← Volver\n');

    const typeChoice = await question('Elige opción: ');

    if (typeChoice === '0') return;

    const targetLevel = await question('¿Hasta qué nivel? (1-20): ');
    const level = parseInt(targetLevel);
    if (isNaN(level)) return;

    const priority = await question('¿Prioridad? (1-10) [10]: ');
    const prio = parseInt(priority) || 10;
    const villageIdInput = await question('Village id (newdid) [main]: ');
    const villageId = normalizeVillageId(villageIdInput);

    const tasks = [];

    // Lógica combinada para opción 5 y 6 (hacen lo mismo: añadir todo)
    if (typeChoice === '5' || typeChoice === '6') {
        console.log('\n🔄 Generando 4 tareas (una por tipo de recurso)...');
        Object.values(RESOURCE_TYPES).forEach(resource => {
            tasks.push({
                account_id: accountId,
                village_id: villageId,
                building_type: resource.type,
                building_name: resource.name,
                target_level: level,
                priority: prio,
                status: 'pending'
            });
        });
    } else if (RESOURCE_TYPES[typeChoice]) {
        // Un solo tipo
        const resource = RESOURCE_TYPES[typeChoice];
        tasks.push({
            account_id: accountId,
            village_id: villageId,
            building_type: resource.type,
            building_name: resource.name,
            target_level: level,
            priority: prio,
            status: 'pending'
        });
    } else {
        console.log('❌ Opción no válida');
        return;
    }

    const { error } = await supabase.from('build_queue').insert(tasks);

    if (error) {
        console.log('❌ Error:', error.message);
    } else {
        console.log(`\n✅ ${tasks.length} tarea(s) añadida(s). El bot subirá TODOS esos campos al nivel ${level}.`);
    }
}

async function addBuildingTask(accountId, villageScan) {
    console.log('\n═══════════════════════════════════════════');
    console.log('   🏛️  SUBIR EDIFICIO');
    console.log('═══════════════════════════════════════════\n');

    if (villageScan && villageScan.buildings) {
        console.log('📍 Edificios detectados:\n');
        villageScan.buildings.filter(b => !b.empty).forEach(b => {
            console.log(`   Slot ${b.slot}: ${b.name} (Nivel ${b.level})`);
        });
        console.log('');
    } else {
        console.log('💡 Edificios comunes:\n');
        Object.entries(COMMON_BUILDINGS).forEach(([key, val]) => {
            console.log(`   ${key}. ${val.name} (slot ${val.defaultSlot})`);
        });
    }

    const input = await question('\nEscribe el NÚMERO DE SLOT o del MENÚ (0 volver): ');
    if (input === '0') return;

    let slot, buildingName;

    if (COMMON_BUILDINGS[input]) {
        slot = COMMON_BUILDINGS[input].defaultSlot;
        buildingName = COMMON_BUILDINGS[input].name;
        const customSlot = await question(`¿Confirmar slot ${slot}? (Enter sí, o escribe otro): `);
        if (customSlot.trim()) {
            const parsed = parseInt(customSlot.trim(), 10);
            if (Number.isNaN(parsed)) {
                console.log('ƒ?O El slot debe ser un numero. Se mantiene el slot por defecto.');
            } else {
                slot = parsed;
            }
        }
    } else {
        slot = parseInt(input);
        if (villageScan && villageScan.buildings) {
            const found = villageScan.buildings.find(b => b.slot === slot);
            if (found) {
                if (found.empty) {
                    buildingName = await question('Edificio a construir en este slot: ');
                } else {
                    buildingName = found.name;
                }
            }
        }
        if (!buildingName) buildingName = await question('Nombre (opcional): ');
    }

    const targetLevel = parseInt(await question('¿Hasta qué nivel?: '));
    const prio = parseInt(await question('¿Prioridad? (1-10) [5]: ') || 5);

    const villageIdInput = await question('Village id (newdid) [main]: ');
    const villageId = normalizeVillageId(villageIdInput);

    const { error } = await supabase.from('build_queue').insert({
        account_id: accountId,
        village_id: villageId,
        building_slot: slot,
        building_name: buildingName || 'Edificio',
        target_level: targetLevel,
        priority: prio,
        status: 'pending'
    });

    if (error) {
        console.log('❌ Error:', error.message);
    } else {
        console.log(`\n✅ Tarea añadida: Slot ${slot} → Nivel ${targetLevel}`);
    }
}

async function showCurrentTasks(accountId) {
    const { data: tasks } = await supabase
        .from('build_queue')
        .select('*')
        .eq('account_id', accountId)
        .eq('status', 'pending')
        .order('priority', { ascending: false });

    console.log('\n📋 TAREAS PENDIENTES:');
    if (!tasks || tasks.length === 0) console.log('   (Ninguna)');
    else {
        tasks.forEach((t, i) => {
            console.log(`   ${i+1}. ${t.building_name} → Nivel ${t.target_level}`);
        });
    }
}

async function clearTasks(accountId) {
    const confirm = await question('⚠️ ¿Borrar TODO? (s/n): ');
    if (confirm === 's') {
        await supabase.from('build_queue').delete().eq('account_id', accountId).eq('status', 'pending');
        console.log('🗑️ Tareas borradas');
    }
}

main().catch(console.error);
