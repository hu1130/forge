# Forge Cloud MySQL 备份与恢复

数据库备份是 Cloud API 的运维职责，不会打进桌面安装包。托管 MySQL 应优先启用平台的自动快照和时间点恢复；仓库命令用于额外的可下载备份与恢复演练。

## 备份

运维机器需要安装与服务端兼容的 `mysqldump`。使用只具备备份所需权限的独立账号，不要使用 Cloud API 运行账号。

```powershell
$env:FORGE_CLOUD_BACKUP_DATABASE_URL = "mysql://备份账号:密码@数据库:3306/forge"
$env:FORGE_CLOUD_BACKUP_DIR = "D:\ForgeBackups"
pnpm cloud:backup
```

命令使用单事务一致性快照，包含表结构、数据、触发器、事件和存储过程，生成权限受限的 `.sql.gz` 文件。数据库密码写入短期临时配置文件，不进入进程命令行；操作结束后自动删除该文件。

## 恢复演练

恢复会覆盖同名表，必须先停止 Cloud API 写流量，并优先在独立测试数据库中演练。恢复账号需要建表、删除表和写入数据的权限。

```powershell
$env:FORGE_CLOUD_RESTORE_DATABASE_URL = "mysql://恢复账号:密码@测试数据库:3306/forge_restore_test"
pnpm cloud:restore -- "D:\ForgeBackups\forge-forge-时间.sql.gz" --confirm=forge_restore_test
```

`--confirm` 必须与连接串中的数据库名完全一致，否则命令拒绝执行。恢复后至少运行：

```powershell
pnpm test:mysql
```

生产环境至少每日备份一次，设置异地副本和保留周期，并每月完成一次真实恢复演练。只有成功恢复并通过租户隔离验证的文件才算有效备份。
