const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(function(file) {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) { 
            results = results.concat(walk(file));
        } else if (file.endsWith('.ts')) {
            const content = fs.readFileSync(file, 'utf8');
            const lines = content.split('\n');
            lines.forEach((line, i) => {
                const match = line.match(/from\s+['"](\.[^'"]+)['"]/);
                if (match) {
                    const importPath = match[1];
                    if (!importPath.endsWith('.js') && !importPath.endsWith('.json')) {
                        console.log(`${file}:${i+1}: ${line}`);
                    }
                }
            });
        }
    });
    return results;
}

walk('./packages');
