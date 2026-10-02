<?php
declare(strict_types=1);
require_once __DIR__.'/overlay/kernel/Database/DecimalStorage.php';
/** One-shot, fail-closed MySQL -> SQLite export. Does not modify the source. */
function ident(string $name): string { return '"' . str_replace('"', '""', $name) . '"'; }
function mysqlIdent(string $name): string { return '`' . str_replace('`', '``', $name) . '`'; }
function queryRows(PDO $db, string $sql, array $args = []): array {
    $q = $db->prepare($sql); $q->execute($args); return $q->fetchAll(PDO::FETCH_ASSOC);
}
function columnDDL(array $c, bool $auto): string {
    $name = ident($c['COLUMN_NAME']); $type = $c['DATA_TYPE']; $checks = [];
    if ($auto) {
        $bits=['tinyint'=>8,'smallint'=>16,'mediumint'=>24,'int'=>32,'bigint'=>64][$type]??null;
        if ($bits===null) throw new RuntimeException('Non-integer auto-increment');
        $unsigned=str_contains($c['COLUMN_TYPE'],'unsigned');
        $min=$unsigned?'0':($bits===64?'-9223372036854775808':(string)(-(2**($bits-1))));
        $max=$bits===64?'9223372036854775807':(string)(2**($unsigned?$bits:$bits-1)-1);
        return "$name INTEGER PRIMARY KEY AUTOINCREMENT CHECK ($name BETWEEN $min AND $max)";
    }
    $integerBits = ['tinyint'=>8, 'smallint'=>16, 'mediumint'=>24, 'int'=>32, 'bigint'=>64];
    if (isset($integerBits[$type])) {
        $sqliteType = 'INTEGER'; $unsigned = str_contains($c['COLUMN_TYPE'], 'unsigned'); $bits = $integerBits[$type];
        $min = $unsigned ? '0' : ($bits === 64 ? '-9223372036854775808' : (string)(-(2 ** ($bits - 1))));
        $max = $bits === 64 ? '9223372036854775807' : (string)(2 ** ($unsigned ? $bits : $bits - 1) - 1);
        $checks[] = "typeof($name) = 'integer' AND $name BETWEEN $min AND $max";
    } elseif (in_array($type, ['decimal','float','double'], true)) {
        $sqliteType = 'NUMERIC';
        $checks[] = "typeof($name) IN ('integer','real')";
        if ($c['NUMERIC_SCALE'] !== null && $c['NUMERIC_PRECISION'] !== null) {
            $scale = (int)$c['NUMERIC_SCALE']; $precision = (int)$c['NUMERIC_PRECISION'];
            if ($precision > 15) throw new RuntimeException('Decimal precision exceeds exact supported reconciliation budget');
            $max = str_repeat('9', $precision - $scale) . ($scale ? '.' . str_repeat('9', $scale) : '');
            $min = str_contains($c['COLUMN_TYPE'], 'unsigned') ? '0' : "-$max";
            $checks[] = "$name BETWEEN $min AND $max";
        }
    } elseif (in_array($type, ['varchar','char','text','mediumtext','longtext','tinytext','datetime','date','timestamp','time','json'], true)) {
        $sqliteType = 'TEXT';
        if ($c['COLLATION_NAME'] !== null && str_ends_with($c['COLLATION_NAME'], '_ci')) $sqliteType .= ' COLLATE NOCASE';
        if (in_array($type, ['varchar','char'], true)) $checks[] = "length($name) <= " . (int)$c['CHARACTER_MAXIMUM_LENGTH'];
        if ($type === 'json') $checks[] = "json_valid($name)";
    } elseif (in_array($type, ['blob','longblob','mediumblob','tinyblob','binary','varbinary'], true)) {
        $sqliteType = 'BLOB';
    } else throw new RuntimeException('Unsupported type ' . $type);
    $ddl = "$name $sqliteType";
    if ($c['IS_NULLABLE'] === 'NO') $ddl .= ' NOT NULL';
    if ($c['COLUMN_DEFAULT'] !== null) $ddl .= " DEFAULT '" . str_replace("'", "''", (string)$c['COLUMN_DEFAULT']) . "'";
    foreach ($checks as $check) $ddl .= " CHECK ($name IS NULL OR ($check))";
    return $ddl;
}
function canonical($value, array $column): ?string {
    if ($value === null) return null;
    $type = $column['DATA_TYPE'];
    if (in_array($type, ['decimal','float','double'], true) && $column['NUMERIC_SCALE'] !== null) {
        $scale = (int)$column['NUMERIC_SCALE'];
        // SQLite NUMERIC uses a double; this formatting detects lost cents at the supported precision.
        return is_float($value) ? number_format($value, $scale, '.', '') : bcadd((string)$value, '0', $scale);
    }
    return (string)$value;
}
function migrateDatabase(PDO $source, string $schema, string $path): array {
    if (!preg_match('/^[a-zA-Z0-9_]+$/D', $schema)) throw new RuntimeException('Unsafe schema name');
    foreach (['TRIGGERS'=>'TRIGGER_SCHEMA','ROUTINES'=>'ROUTINE_SCHEMA','EVENTS'=>'EVENT_SCHEMA'] as $table=>$key) {
        if (queryRows($source, "SELECT 1 FROM information_schema.$table WHERE $key = ? LIMIT 1", [$schema])) throw new RuntimeException("Unsupported $table in $schema");
    }
    if (queryRows($source, "SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? AND CONSTRAINT_TYPE='CHECK' LIMIT 1", [$schema])) throw new RuntimeException('Source CHECK constraints require explicit conversion');
    $tables = queryRows($source, 'SELECT TABLE_NAME,TABLE_TYPE,ENGINE,AUTO_INCREMENT,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', [$schema]);
    $handle = @fopen($path, 'x'); if ($handle === false) throw new RuntimeException('Destination already exists or cannot be exclusively created');
    fclose($handle); chmod($path, 0600);
    $out = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
    \Kernel\Database\DecimalStorage::register($out);
    $out->exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=OFF');
    $report = ['schema'=>$schema,'tables'=>[],'collation_policy'=>'NOCASE: ASCII case-insensitive only; Unicode accents/case and trailing-space semantics differ from MySQL','non_transactional_tables'=>[]];
    try {
        $out->beginTransaction(); $metadata = [];
        foreach ($tables as $table) {
            $name = $table['TABLE_NAME'];
            if ($table['TABLE_TYPE'] !== 'BASE TABLE') throw new RuntimeException('Views unsupported');
            if ($table['ENGINE'] !== 'InnoDB') $report['non_transactional_tables'][] = $name;
            $columns = queryRows($source, 'SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [$schema,$name]);
            $indexes = queryRows($source, 'SELECT * FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', [$schema,$name]);
            $definitions=[]; $primary=[]; $groups=[]; $auto=null;
            foreach ($indexes as $index) {
                if ($index['INDEX_TYPE'] !== 'BTREE' || $index['SUB_PART'] !== null || $index['COLUMN_NAME'] === null) throw new RuntimeException('Unsupported index');
                $groups[$index['INDEX_NAME']][]=$index;
                if ($index['INDEX_NAME'] === 'PRIMARY') $primary[]=$index['COLUMN_NAME'];
            }
            foreach ($columns as $column) {
                if (!in_array($column['EXTRA'], ['', 'auto_increment'], true) || ($column['GENERATION_EXPRESSION'] ?? '') !== '') throw new RuntimeException('Unsupported generated/automatic column');
                $isAuto = $column['EXTRA'] === 'auto_increment';
                if ($isAuto) {
                    if ($primary !== [$column['COLUMN_NAME']]) throw new RuntimeException('Unsupported compound auto-increment');
                    $auto=$column['COLUMN_NAME'];
                }
                $definitions[]=columnDDL($column,$isAuto);
            }
            if (!$auto && $primary) $definitions[]='PRIMARY KEY ('.implode(',',array_map('ident',$primary)).')';
            $foreign = queryRows($source, 'SELECT k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON k.CONSTRAINT_SCHEMA=r.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME=r.CONSTRAINT_NAME AND k.TABLE_NAME=r.TABLE_NAME WHERE k.TABLE_SCHEMA=? AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION', [$schema,$name]);
            $fkGroups=[]; foreach ($foreign as $fk) $fkGroups[$fk['CONSTRAINT_NAME']][]=$fk;
            foreach ($fkGroups as $rows) {
                $fk=$rows[0]; if ($fk['REFERENCED_TABLE_SCHEMA']!==$schema) throw new RuntimeException('Cross-database FK unsupported');
                foreach (['UPDATE_RULE','DELETE_RULE'] as $rule) if (!in_array($fk[$rule],['CASCADE','SET NULL','RESTRICT','NO ACTION'],true)) throw new RuntimeException('Unsupported FK action');
                $definitions[]='FOREIGN KEY ('.implode(',',array_map(fn($r)=>ident($r['COLUMN_NAME']),$rows)).') REFERENCES '.ident($fk['REFERENCED_TABLE_NAME']).' ('.implode(',',array_map(fn($r)=>ident($r['REFERENCED_COLUMN_NAME']),$rows)).') ON UPDATE '.$fk['UPDATE_RULE'].' ON DELETE '.$fk['DELETE_RULE'];
            }
            $out->exec('CREATE TABLE '.ident($name).' ('.implode(',', $definitions).')');
            foreach ($groups as $indexName=>$rows) {
                if ($indexName==='PRIMARY') continue;
                $out->exec('CREATE '.((int)$rows[0]['NON_UNIQUE']===0?'UNIQUE ':'').'INDEX '.ident($name.'__'.$indexName).' ON '.ident($name).' ('.implode(',',array_map(fn($r)=>ident($r['COLUMN_NAME']).($r['COLLATION']==='D'?' DESC':''),$rows)).')');
            }
            // Match MySQL fixed-scale storage for existing commission/price arithmetic.
            $scaled=array_values(array_filter($columns,fn($c)=>in_array($c['DATA_TYPE'],['decimal','float','double'],true) && $c['NUMERIC_SCALE']!==null));
            if ($scaled) {
                if (!$primary) throw new RuntimeException('Rounding triggers require primary key');
                $changed=implode(' OR ',array_map(fn($c)=>'NEW.'.ident($c['COLUMN_NAME']).' != CAST(decimal_round(NEW.'.ident($c['COLUMN_NAME']).','.(int)$c['NUMERIC_SCALE'].') AS NUMERIC)',$scaled));
                $set=implode(',',array_map(fn($c)=>ident($c['COLUMN_NAME']).'=decimal_round(NEW.'.ident($c['COLUMN_NAME']).','.(int)$c['NUMERIC_SCALE'].')',$scaled));
                $where=implode(' AND ',array_map(fn($c)=>ident($c).'=NEW.'.ident($c),$primary));
                foreach(['INSERT','UPDATE'] as $event) $out->exec('CREATE TRIGGER '.ident($name.'__round_'.strtolower($event)).' AFTER '.$event.' ON '.ident($name).' WHEN '.$changed.' BEGIN UPDATE '.ident($name).' SET '.$set.' WHERE '.$where.'; END');
            }
            $uniqueColumns=[];
            foreach($groups as $rows) if ((int)$rows[0]['NON_UNIQUE']===0) foreach($rows as $idx) $uniqueColumns[$idx['COLUMN_NAME']]=true;
            $metadata[$name]=[$columns,$primary,$auto,$table['AUTO_INCREMENT'],$uniqueColumns];
            $report['tables'][$name]=['rows'=>0,'indexes'=>count($groups),'foreign_keys'=>count($fkGroups),'non_ascii_text_values'=>0,'trailing_space_text_values'=>0,'source_collation'=>$table['TABLE_COLLATION'],'non_ascii_unique_values'=>0,'trailing_space_unique_values'=>0];
        }
        foreach ($metadata as $name=>[$columns,$primary,$auto,$next,$uniqueColumns]) {
            if (!$primary) throw new RuntimeException('Primary key required for deterministic reconciliation');
            $sql='SELECT * FROM '.mysqlIdent($schema).'.'.mysqlIdent($name).' ORDER BY '.implode(',',array_map('mysqlIdent',$primary));
            $read=$source->query($sql);
            $insert=$out->prepare('INSERT INTO '.ident($name).' ('.implode(',',array_map(fn($c)=>ident($c['COLUMN_NAME']),$columns)).') VALUES ('.implode(',',array_fill(0,count($columns),'?')).')');
            $digest=hash_init('sha256');
            while ($row=$read->fetch(PDO::FETCH_ASSOC)) {
                $values=[]; $canonical=[];
                foreach ($columns as $i=>$column) {
                    $value=$row[$column['COLUMN_NAME']];
                    if ($column['DATA_TYPE']==='bigint' && $value!==null && bccomp((string)$value,'9223372036854775807')>0) throw new RuntimeException('Unsigned bigint exceeds SQLite range');
                    $normal=canonical($value,$column); $canonical[]=$normal;
                    if ($value!==null && $column['CHARACTER_SET_NAME']!==null) {
                        if (preg_match('/[^\x00-\x7f]/', (string)$value)) { $report['tables'][$name]['non_ascii_text_values']++; if(isset($uniqueColumns[$column['COLUMN_NAME']])) $report['tables'][$name]['non_ascii_unique_values']++; }
                        if (str_ends_with((string)$value,' ')) { $report['tables'][$name]['trailing_space_text_values']++; if(isset($uniqueColumns[$column['COLUMN_NAME']])) $report['tables'][$name]['trailing_space_unique_values']++; }
                    }
                    $insert->bindValue($i+1,$normal,$normal===null?PDO::PARAM_NULL:(str_contains($column['DATA_TYPE'],'blob')?PDO::PARAM_LOB:PDO::PARAM_STR));
                }
                $insert->execute(); hash_update($digest,serialize($canonical)); $report['tables'][$name]['rows']++;
            }
            $expected=hash_final($digest); $digest=hash_init('sha256'); $count=0;
            $read=$out->query('SELECT * FROM '.ident($name).' ORDER BY '.implode(',',array_map('ident',$primary)));
            while ($row=$read->fetch(PDO::FETCH_ASSOC)) { $canonical=[]; foreach($columns as $column) $canonical[]=canonical($row[$column['COLUMN_NAME']],$column); hash_update($digest,serialize($canonical)); $count++; }
            if ($count!==$report['tables'][$name]['rows'] || hash_final($digest)!==$expected) throw new RuntimeException('Full-row reconciliation failed: '.$name);
            $report['tables'][$name]['reconciled']=true;
            // Preserve a higher next ID after deletions, not merely max(existing ID).
            if ($auto && $next!==null) { $q=$out->prepare('UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name=?'); $q->execute([(int)$next-1,$name]); if (!$q->rowCount()) { $q=$out->prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)'); $q->execute([$name,(int)$next-1]); } }
        }
        if ($out->query('PRAGMA foreign_key_check')->fetch()) throw new RuntimeException('Foreign-key reconciliation failed');
        if ($out->query('PRAGMA quick_check')->fetchColumn()!=='ok') throw new RuntimeException('SQLite integrity check failed');
        $out->commit(); $out=null; $report['file_sha256']=hash_file('sha256',$path); return $report;
    } catch (Throwable $e) {
        if ($out->inTransaction()) $out->rollBack(); $out=null;
        // Keep failed artifacts unmistakably separate; never silently reuse partial output.
        rename($path,$path.'.failed'); throw $e;
    }
}
function migrationMain(array $argv): void {
    $opts=getopt('', ['defaults-file:','output-dir:','quiesced']);
    if (!isset($opts['defaults-file'],$opts['output-dir'])) throw new RuntimeException('Usage: php migrate.php --defaults-file=/private/client.cnf --output-dir=/private/new-directory [--quiesced]');
    $credentials=parse_ini_file($opts['defaults-file'],true,INI_SCANNER_RAW)['client'] ?? [];
    $host=$credentials['host']??'127.0.0.1'; $port=$credentials['port']??'3306';
    $source=new PDO("mysql:host=$host;port=$port;charset=utf8mb4",$credentials['user']??'', $credentials['password']??'', [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_STRINGIFY_FETCHES=>true]);
    $source->exec('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    $source->exec('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    $schemas=queryRows($source,"SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY SCHEMA_NAME");
    $dir=rtrim($opts['output-dir'],'/'); if (!mkdir($dir,0700)) throw new RuntimeException('Output directory must be new');
    $report=['version'=>1,'started_at'=>gmdate('c'),'quiesced'=>isset($opts['quiesced']),'databases'=>[]];
    try {
        foreach($schemas as $row) { $name=$row['SCHEMA_NAME']; $report['databases'][]=migrateDatabase($source,$name,"$dir/$name.sqlite"); }
        $source->commit(); $report['completed_at']=gmdate('c');
        file_put($dir.'/manifest.json',json_encode($report,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES)."\n");
        echo json_encode(['databases'=>count($report['databases']),'tables'=>array_sum(array_map(fn($d)=>count($d['tables']),$report['databases'])),'manifest'=>$dir.'/manifest.json','quiesced'=>$report['quiesced']],JSON_UNESCAPED_SLASHES)."\n";
    } catch (Throwable $e) { if($source->inTransaction()) $source->rollBack(); throw $e; }
}
function file_put(string $path,string $data): void { if(file_put_contents($path,$data,LOCK_EX)===false) throw new RuntimeException('Cannot write manifest'); chmod($path,0600); }
if (realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__) {
    try { migrationMain($argv); } catch(Throwable $e) { fwrite(STDERR,'Migration failed: '.$e->getMessage()."\n"); exit(1); }
}
