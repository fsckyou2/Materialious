import { Sequelize, DataTypes, Model, type ModelCtor } from 'sequelize';
import { env } from '$env/dynamic/private';

let UserTable: ModelCtor<Model<any, any>>;
let ChannelSubscriptionTable: ModelCtor<Model<any, any>>;
let CaptchaTable: ModelCtor<Model<any, any>>;
let UserKeyValueTable: ModelCtor<Model<any, any>>;
let UserHistoryTable: ModelCtor<Model<any, any>>;
let DeviceTable: ModelCtor<Model<any, any>>;

let sequelizeInstance: Sequelize | null = null;

// Don't want to make our Sequelize instance always
export function getSequelize(): {
	sequelize: Sequelize;
	UserTable: ModelCtor<Model<any, any>>;
	ChannelSubscriptionTable: ModelCtor<Model<any, any>>;
	CaptchaTable: ModelCtor<Model<any, any>>;
	UserKeyValueTable: ModelCtor<Model<any, any>>;
	UserHistoryTable: ModelCtor<Model<any, any>>;
	DeviceTable: ModelCtor<Model<any, any>>;
} {
	if (sequelizeInstance) {
		return {
			sequelize: sequelizeInstance,
			UserTable,
			ChannelSubscriptionTable,
			CaptchaTable,
			UserKeyValueTable,
			UserHistoryTable,
			DeviceTable
		};
	}

	if (!env.DATABASE_CONNECTION_URI) {
		throw new Error('DATABASE_CONNECTION_URI must be set');
	}

	sequelizeInstance = new Sequelize(env.DATABASE_CONNECTION_URI);

	UserTable = sequelizeInstance.define(
		'User',
		{
			id: {
				type: DataTypes.UUIDV4,
				allowNull: false,
				primaryKey: true,
				unique: true
			},
			username: {
				type: DataTypes.STRING,
				allowNull: false,
				unique: true
			},
			passwordHash: {
				type: DataTypes.STRING,
				allowNull: false
			},
			passwordSalt: {
				type: DataTypes.STRING,
				allowNull: false
			},
			created: {
				type: DataTypes.DATE,
				allowNull: false
			},
			decryptionKeySalt: {
				type: DataTypes.STRING,
				allowNull: false
			},
			masterKeyCipher: {
				type: DataTypes.STRING,
				allowNull: false
			},
			masterKeyNonce: {
				type: DataTypes.STRING,
				allowNull: false
			}
		},
		{
			indexes: [
				{
					unique: true,
					fields: ['id', 'username']
				}
			]
		}
	);

	UserKeyValueTable = sequelizeInstance.define(
		'UserKeyValue',
		{
			key: {
				type: DataTypes.STRING,
				allowNull: false
			},
			valueCipher: {
				type: DataTypes.STRING,
				allowNull: false
			},
			valueNonce: {
				type: DataTypes.STRING,
				allowNull: false
			}
		},
		{
			indexes: [
				{
					unique: true,
					fields: ['UserId', 'key']
				}
			]
		}
	);

	UserHistoryTable = sequelizeInstance.define('UserHistory', {
		id: {
			type: DataTypes.STRING,
			allowNull: false,
			primaryKey: true
		},
		watched: {
			type: DataTypes.DATE,
			allowNull: false
		},
		lengthSeconds: {
			type: DataTypes.INTEGER,
			allowNull: false
		},
		progress: {
			type: DataTypes.INTEGER,
			allowNull: false
		},
		videoIdCipher: {
			type: DataTypes.STRING,
			allowNull: false
		},
		videoIdNonce: {
			type: DataTypes.STRING,
			allowNull: false
		},
		titleCipher: {
			type: DataTypes.STRING,
			allowNull: false
		},
		titleNonce: {
			type: DataTypes.STRING,
			allowNull: false
		},
		authorCipher: {
			type: DataTypes.STRING,
			allowNull: false
		},
		authorNonce: {
			type: DataTypes.STRING,
			allowNull: false
		},
		thumbnailCipher: {
			type: DataTypes.STRING,
			allowNull: false
		},
		thumbnailNonce: {
			type: DataTypes.STRING,
			allowNull: false
		}
	});

	ChannelSubscriptionTable = sequelizeInstance.define('Subscriptions', {
		id: {
			type: DataTypes.STRING,
			allowNull: false,
			primaryKey: true
		},
		channelIdCipher: {
			type: DataTypes.STRING,
			allowNull: false
		},
		channelIdNonce: {
			type: DataTypes.STRING,
			allowNull: false
		},
		channelNameCipher: {
			type: DataTypes.STRING,
			allowNull: false
		},
		channelNameNonce: {
			type: DataTypes.STRING,
			allowNull: false
		},
		lastRSSFetch: {
			type: DataTypes.DATE,
			allowNull: false
		}
	});

	CaptchaTable = sequelizeInstance.define('Captchas', {
		signature: {
			type: DataTypes.STRING,
			allowNull: false,
			primaryKey: true
		},
		created: {
			type: DataTypes.DATE,
			allowNull: false
		}
	});

	// Televisions paired to an account. The name is stored in the clear, unlike
	// subscriptions and history: it is chosen by the viewer for a device in
	// their own home, and the browser has to show it in a picker without
	// holding the master key.
	DeviceTable = sequelizeInstance.define('Devices', {
		id: {
			type: DataTypes.STRING,
			allowNull: false,
			primaryKey: true
		},
		name: {
			type: DataTypes.STRING,
			allowNull: false
		},
		// Only a hash is kept, so a database read does not yield working tokens.
		tokenHash: {
			type: DataTypes.STRING,
			allowNull: false
		},
		created: {
			type: DataTypes.DATE,
			allowNull: false
		},
		lastSeen: {
			type: DataTypes.DATE,
			allowNull: true
		}
	});

	UserTable.hasMany(ChannelSubscriptionTable);
	UserTable.hasMany(UserKeyValueTable);
	UserTable.hasMany(UserHistoryTable);
	UserTable.hasMany(DeviceTable);

	return {
		sequelize: sequelizeInstance,
		UserTable,
		ChannelSubscriptionTable,
		CaptchaTable,
		UserKeyValueTable,
		UserHistoryTable,
		DeviceTable
	};
}

export interface ChannelSubscriptionModel {
	id: string; // Hashed authId with subscription key on client.
	channelIdCipher: string;
	channelIdNonce: string;
	channelNameCipher: string;
	channelNameNonce: string;
	lastRSSFetch: Date;
	userId: string;
}

export interface UserTableModel extends Model {
	id: string;
	username: string;
	passwordHash: string;
	passwordSalt: string;
	created: Date;
	decryptionKeySalt: string;
	masterKeyCipher: string;
	masterKeyNonce: string;
}

export interface UserKeyStoreModel {
	key: string;
	valueCipher: string;
	valueNonce: string;
}

export interface DeviceModel extends Model {
	id: string;
	name: string;
	tokenHash: string;
	created: Date;
	lastSeen: Date | null;
	UserId: string;
}
