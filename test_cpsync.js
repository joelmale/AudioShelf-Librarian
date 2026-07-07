const fs = require('fs');
try {
  fs.mkdirSync('test_dir', { recursive: true });
  fs.writeFileSync('test_dir/test.txt', 'test');
  fs.cpSync('test_dir', 'test_dir', { recursive: true });
  console.log("Success");
} catch(e) {
  console.error(e.message);
}
