const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.resolve('c:/Users/l00926210/Documents/Workspace/Placement_Nova/data/placement.db');

async function run() {
    const SQL = await initSqlJs();
    const fileBuffer = fs.readFileSync(DB_PATH);
    const db = new SQL.Database(fileBuffer);
    
    const id = uuidv4();
    try {
        db.run("INSERT INTO functions (id, name, region, auth_policy) VALUES (?, ?, ?, 'public')", [id, 'test', 'dz']);
        const data = db.export();
        fs.writeFileSync(DB_PATH, Buffer.from(data));
        console.log("Successfully inserted function 'test' in region 'dz' with id: " + id);
    } catch(err) {
        if (err.message.includes('UNIQUE constraint failed')) {
            console.log("Function 'test' in 'dz' already exists.");
        } else {
            console.error("Error inserting: " + err.message);
        }
    }
}

run();
