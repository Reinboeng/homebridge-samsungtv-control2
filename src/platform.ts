import {
  API,
  APIEvent,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
  DynamicPlatformPlugin,
} from 'homebridge'
import { PLUGIN_NAME, PLATFORM_NAME } from './settings'
import detectDevices from './utils/detectDevices'
import * as remote from './utils/remote'
import hasCapability from './utils/hasCapability'
import parseKeys from './utils/parseKeys'
import { DeviceConfig, SamsungPlatformConfig } from './types/deviceConfig'
import { KEYS, APPS } from 'samsung-tv-control'
import storage from 'node-persist'
import chalk from 'chalk'
import path from 'path'

const DEVICES_KEY = `${PLATFORM_NAME}_devices`

export class SamsungTVHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service
  public readonly Characteristic: typeof Characteristic = this.api.hap
    .Characteristic

  public readonly tvAccessories: Array<PlatformAccessory> = []
  private devices: Array<DeviceConfig> = []

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log = log
    this.config = config
    this.api = api

    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic

    this.log.debug(`Got config`, this.config)

    // Add devices
    api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
      const dir = path.join(api.user.storagePath(), `.${PLUGIN_NAME}`)
      this.log.debug(`Using node-persist path:`, dir)
      await storage.init({
        dir,
        logging: (...args) => this.log.debug(`${PLATFORM_NAME} db -`, ...args),
      })

      let devices = await this.discoverDevices()
      devices = await this.applyConfig(devices)
      this.devices = await this.checkDevicePairing(devices)

      // Register all TV's
      for (const device of this.devices) {
        // Log all devices so that the user knows how to configure them
        this.log.info(
          chalk`Found device {blue ${device.name}} (${device.modelName}), usn: {green ${device.usn}}`,
        )
        this.log.debug(
          `${device.name} - (ip: ${device.lastKnownIp}, mac: ${device.mac})`,
        )
        // Register it
        this.registerTV(device.usn)
      }

      // Regularly discover upnp devices and update ip's, locations for registered devices
      setInterval(async () => {
        const devices = await this.discoverDevices()
        this.devices = await this.applyConfig(devices)
        /**
         * @todo
         * add previously not registered devices
         */
      }, 1000 * 60 * 5 /* 5min */)

      /**
       * @TODO
       * Add subscriptions to update getters
       */
    })
  }

  /*
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(): void {
    this.log.debug(`Configuring accessory`)
  }

  private async discoverDevices() {
    let existingDevices: Array<DeviceConfig> = await storage.getItem(
      DEVICES_KEY,
    )
    if (!Array.isArray(existingDevices)) {
      existingDevices = []
    }

    const devices: Array<DeviceConfig> = []
    const samsungTVs = await detectDevices(
      // this.log,
      this.config as SamsungPlatformConfig,
    )
    for (const tv of samsungTVs) {
      const {
        usn,
        friendlyName: name,
        modelName,
        location: lastKnownLocation,
        address: lastKnownIp,
        mac,
        capabilities,
      } = tv
      const device: DeviceConfig = {
        name,
        modelName,
        lastKnownLocation,
        lastKnownIp,
        mac,
        usn,
        delay: 500,
        capabilities,
      }
      // Check if the tv was in the devices list before
      // if so, only replace the relevant parts
      // const existingDevice = devices[usn];
      const existingDevice = existingDevices.find((d) => d.usn === usn)
      if (existingDevice) {
        this.log.debug(
          `Rediscovered previously seen device "${device.name}" (${device.modelName}), usn: "${device.usn}"`,
        )
        devices.push({
          ...existingDevice,
          modelName: device.modelName,
          lastKnownLocation: device.lastKnownLocation,
          lastKnownIp: device.lastKnownIp,
          token: device.token,
          discovered: true,
        })
      } else {
        this.log.debug(
          `Discovered new device "${device.name}" (${device.modelName}), usn: "${device.usn}"`,
        )
        devices.push({ ...device, discovered: true })
      }
    }

    // Add all existing devices that where not discovered
    for (const existingDevice of existingDevices) {
      const { usn } = existingDevice
      const device = devices.find((d) => d.usn === usn)
      if (!device) {
        this.log.debug(
          `Adding not discovered, previously seen device "${existingDevice.name}" (${existingDevice.modelName}), usn: "${existingDevice.usn}"`,
        )
        devices.push(existingDevice)
      }
    }

    // Update devices
    await storage.updateItem(DEVICES_KEY, devices)
    return devices
  }

  /**
   * Invokes pairing for all discovered devices.
   */
  private async checkDevicePairing(devices: Array<DeviceConfig>) {
    for (const device of devices) {
      // Try pairing if the device was actually discovered and not paired already
      if (!device.ignore && device.discovered) {
        try {
          const token = await remote.getPairing(device, this.log)
          if (token) {
            this.log.debug(
              `Found pairing token "${token}" for "${device.name}" (${device.modelName}), usn: "${device.usn}".`,
            )
          }
        } catch (err) {
          this.log.warn(
            `Did not receive pairing token. Either you did not click "Allow" in time or your TV might not be supported.` +
              `You might just want to restart homebridge and retry.`,
          )
        }
      }
    }
    return devices
  }

  /**
   * Adds the user modifications to each of devices
   */
  private async applyConfig(devices: Array<DeviceConfig>) {
    // Get additional options from config
    const configDevices = (this.config as SamsungPlatformConfig).devices || []
    for (const configDevice of configDevices) {
      // Search for the device in the persistent devices and overwrite the values
      const { usn } = configDevice
      const deviceIdx = devices.findIndex((d) => d.usn === usn)
      if (deviceIdx === -1) {
        this.log.debug(
          `Found config for unknown device usn: "${configDevice.usn}"`,
          configDevice,
        )
        continue
      }
      const device = devices[deviceIdx]
      this.log.debug(
        `Found config for device "${device.name}" (${device.modelName}), usn: "${device.usn}"`,
      )
      devices[deviceIdx] = {
        ...device,
        ...configDevice,
      }
    }
    return devices
  }

  private getDevice(usn) {
    const device = this.devices.find((d) => d.usn === usn)
    return device as DeviceConfig
  }

  private registerTV(usn: string) {
    const device = this.getDevice(usn)
    if (!device || device.ignore) {
      return
    }

    // generate a UUID
    const uuid = this.api.hap.uuid.generate(device.usn)

    // create the accessory
    const tvAccessory = new this.api.platformAccessory(device.name, uuid)
    tvAccessory.context = device

    this.tvAccessories.push(tvAccessory)

    // get the name
    const tvName = device.name

    // set the accessory category
    tvAccessory.category = this.api.hap.Categories.TELEVISION

    // add the tv service
    const tvService = tvAccessory.addService(this.Service.Television)
    // set the tv name, manufacturer etc.
    tvService.setCharacteristic(this.Characteristic.ConfiguredName, tvName)

    const accessoryService =
      tvAccessory.getService(this.Service.AccessoryInformation) ||
      new this.Service.AccessoryInformation()
    accessoryService
      .setCharacteristic(this.Characteristic.Model, device.modelName)
      .setCharacteristic(
        this.Characteristic.Manufacturer,
        `Samsung Electronics`,
      )
      .setCharacteristic(this.Characteristic.Name, device.name)
      .setCharacteristic(this.Characteristic.SerialNumber, device.usn)

    // set sleep discovery characteristic
    tvService.setCharacteristic(
      this.Characteristic.SleepDiscoveryMode,
      this.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
    )

    // handle on / off events using the Active characteristic
    tvService
      .getCharacteristic(this.Characteristic.Active)
      .on(`get`, async (callback) => {
        this.log.debug(`${tvName} - GET Active`)
        try {
          const isActive = await remote.getActive(this.getDevice(usn))
          callback(null, isActive)
        } catch (err) {
          callback(err)
        }
      })
      .on(`set`, async (newValue, callback) => {
        this.log.debug(`${tvName} - SET Active => setNewValue: ${newValue}`)
        try {
          await remote.setActive(this.getDevice(usn), newValue as boolean)
          tvService.updateCharacteristic(
            this.Characteristic.Active,
            newValue
              ? this.Characteristic.Active.ACTIVE
              : this.Characteristic.Active.INACTIVE,
          )
          callback(null)
        } catch (err) {
          callback(err)
        }
      })

    // Update the active state every 15 seconds
    setInterval(async () => {
      let newState = this.Characteristic.Active.ACTIVE
      try {
        const isActive = await remote.getActive(this.getDevice(usn))
        if (!isActive) {
          newState = this.Characteristic.Active.INACTIVE
        }
      } catch (err) {
        newState = this.Characteristic.Active.INACTIVE
      }
      // this.log.debug('Polled tv active state', newState);
      tvService.updateCharacteristic(this.Characteristic.Active, newState)
    }, 1000 * 15)

    const canGetBrightness = hasCapability(device, `GetBrightness`)
    const canSetBrightness = hasCapability(device, `SetBrightness`)
    if (canGetBrightness) {
      tvService
        .getCharacteristic(this.Characteristic.Brightness)
        .on(`get`, async (callback) => {
          this.log.debug(`${tvName} - GET Brightness`)
          try {
            const brightness = await remote.getBrightness(this.getDevice(usn))
            callback(null, brightness)
          } catch (err) {
            callback(err)
          }
        })
    }
    if (canSetBrightness) {
      tvService
        .getCharacteristic(this.Characteristic.Brightness)
        .on(`set`, async (newValue, callback) => {
          this.log.debug(
            `${tvName} - SET Brightness => setNewValue: ${newValue}`,
          )
          try {
            await remote.setBrightness(this.getDevice(usn), newValue as number)
            tvService.updateCharacteristic(
              this.Characteristic.Brightness,
              newValue,
            )
            callback(null)
          } catch (err) {
            callback(err)
          }
        })
    }

    // handle remote control input
    tvService
      .getCharacteristic(this.Characteristic.RemoteKey)
      .on(`set`, async (newValue, callback) => {
        try {
          switch (newValue) {
            case this.Characteristic.RemoteKey.REWIND: {
              this.log.debug(`${tvName} - SET Remote Key Pressed: REWIND`)
              await remote.rewind(this.getDevice(usn))
              break
            }
            case this.Characteristic.RemoteKey.FAST_FORWARD: {
              this.log.debug(`${tvName} - SET Remote Key Pressed: FAST_FORWARD`)
              await remote.fastForward(this.getDevice(usn))
              break
            }
            case this.Characteristic.RemoteKey.NEXT_TRACK: {
              this.log.debug(`${tvName} - SET Remote Key Pressed: NEXT_TRACK`)
              break
            }
            case this.Characteristic.RemoteKey.PREVIOUS_TRACK: {
              this.log.debug(
                `${tvName} - SET Remote Key Pressed: PREVIOUS_TRACK`,
              )
              break
            }
            case this.Characteristic.RemoteKey.ARROW_UP: {
              this.log.debug(`${tvName} - SET Remote Key Pressed: ARROW_UP`)
              await remote.arrowUp(this.getDevice(usn))
              break
            }
            case this.Characteristic.RemoteKey.ARROW_DOWN: {
              this.log.debug(`${tvName} - SET Remote Key Pressed: ARROW_DOWN`)
              await remote.arrowDown(this.getDevice(usn))
              break
            }
            case this.Characteristic.RemoteKey.ARROW_LEFT: {
              this.log.debug(`${tvName} - SET Remote Key Pressed: ARROW_LEFT`)
              await remote.arrowLeft(this.getDevice(usn))
              break
            }
            case this.Characteristic.RemoteKey.ARROW_RIGHT: {
              this.log.debug(`${tvName} - SET Remote Key Pressed: ARROW_RIGHT`)
              await remote.arrowRight(this.getDevice(usn))
              break
            }
            case this.Characteristic.RemoteKey.SELECT: {
              this.log.debug(`${tvName} - SET Remote Key Pressed: SELECT`)
              await remote.select(this.getDevice(usn))
              break
            }
            case this.Characteristic.RemoteKey.BACK: {
              this.log.debug(`${tvName} - SET Remote Key Pressed: BACK`)
              await remote.back(this.getDevice(usn))
              break
            }
            case this.Characteristic.RemoteKey.EXIT: {
              this.log.debug(`${tvName} - SET Remote Key Pressed: EXIT`)
              await remote.exit(this.getDevice(usn))
              break
            }
            case this.Characteristic.RemoteKey.PLAY_PAUSE: {
              this.log.debug(`${tvName} - SET Remote Key Pressed: PLAY_PAUSE`)
              break
            }
            case this.Characteristic.RemoteKey.INFORMATION: {
              this.log.debug(`${tvName} - SET Remote Key Pressed: INFORMATION`)
              await remote.info(this.getDevice(usn))
              break
            }
          }
        } catch (err) {
          callback(err)
          return
        }
        callback(null)
      })

    /**
     * Create a speaker service to allow volume control
     */
    const speakerService = tvAccessory.addService(
      this.Service.TelevisionSpeaker,
    )

    /**
     * We have these scenarios
     * 1. GetVolume + SetVolume:
     *    => VolumeControlType.Absolute
     *    => Add Volume Characteristic with get/set
     *    => Also add VolumeSelector
     * (2.) GetVolume but (no SetVolume)
     *    ...same as 1. because SetVolume can be simulated
     *       by inc./decr. volume step by step
     *    => ~~VolumeControlType.RELATIVE_WITH_CURRENT~~
     *    => ~~Add Volume Characteristic with getter only~~
     * 3. No GetVolume upnp capabilities:
     *    => VolumeControlType.RELATIVE
     *    => Add VolumeSelector Characteristic
     */

    let volumeControlType = this.Characteristic.VolumeControlType.ABSOLUTE
    const canGetVolume = hasCapability(device, `GetVolume`)
    if (!canGetVolume) {
      volumeControlType = this.Characteristic.VolumeControlType.RELATIVE
      this.log.debug(`${tvName} - VolumeControlType RELATIVE`)
    } else {
      this.log.debug(`${tvName} - VolumeControlType ABSOLUTE`)
    }

    speakerService
      .setCharacteristic(
        this.Characteristic.Active,
        this.Characteristic.Active.ACTIVE,
      )
      .setCharacteristic(
        this.Characteristic.VolumeControlType,
        volumeControlType,
      )

    if (canGetVolume) {
      speakerService
        .getCharacteristic(this.Characteristic.Volume)
        .on(`get`, async (callback) => {
          this.log.debug(`${tvName} - GET Volume`)
          try {
            const volume = await remote.getVolume(this.getDevice(usn))
            callback(null, volume)
          } catch (err) {
            callback(err)
          }
        })
    }

    // When we can get the volume, we can always set the volume
    // directly or simulate it by  multiple volup/downs
    if (canGetVolume) {
      speakerService
        .getCharacteristic(this.Characteristic.Volume)
        .on(`set`, async (newValue, callback) => {
          this.log.debug(`${tvName} - SET Volume => setNewValue: ${newValue}`)
          try {
            await remote.setVolume(this.getDevice(usn), newValue as number)
            speakerService
              .getCharacteristic(this.Characteristic.Mute)
              .updateValue(false)
            callback(null)
          } catch (err) {
            callback(err)
          }
        })
    }

    // VolumeSelector can be used in all scenarios
    speakerService
      .getCharacteristic(this.Characteristic.VolumeSelector)
      .on(`set`, async (newValue, callback) => {
        this.log.debug(
          `${tvName} - SET VolumeSelector => setNewValue: ${newValue}`,
        )
        try {
          if (newValue === this.Characteristic.VolumeSelector.INCREMENT) {
            await remote.volumeUp(this.getDevice(usn))
          } else {
            await remote.volumeDown(this.getDevice(usn))
          }
          const volume = await remote.getVolume(this.getDevice(usn))
          speakerService
            .getCharacteristic(this.Characteristic.Mute)
            .updateValue(false)
          speakerService
            .getCharacteristic(this.Characteristic.Volume)
            .updateValue(volume)
          callback(null)
        } catch (err) {
          callback(err)
        }
      })

    const canGetMute = hasCapability(device, `GetMute`)
    speakerService
      .getCharacteristic(this.Characteristic.Mute)
      .on(`get`, async (callback) => {
        this.log.debug(`${tvName} - GET Mute`)
        // When mute cannot be fetched always pretend not to be muted
        // for now...
        if (!canGetMute) {
          callback(null, false)
          return
        }
        try {
          const muted = await remote.getMute(this.getDevice(usn))
          callback(null, muted)
        } catch (err) {
          callback(err)
        }
      })
      .on(`set`, async (value, callback) => {
        this.log.debug(`${tvName} - SET Mute: ${value}`)
        try {
          await remote.setMute(this.getDevice(usn), value as boolean)
          callback(null)
        } catch (err) {
          callback(err)
        }
      })

    tvService.addLinkedService(speakerService)

    const inputSources = [
      { label: `-`, type: this.Characteristic.InputSourceType.OTHER },
      {
        label: `TV`,
        type: this.Characteristic.InputSourceType.TUNER,
        fn: remote.openTV,
      },
    ]
    const sources = [...inputSources]
    const { inputs = [] } = device
    for (const cInput of inputs) {
      // Opening apps
      if (APPS[cInput.keys]) {
        sources.push({
          label: cInput.name,
          type: this.Characteristic.InputSourceType.APPLICATION,
          fn: async (config: DeviceConfig) => {
            await remote.openApp(config, APPS[cInput.keys])
          },
        })
        continue
      }
      // Sending keys
      const keys = parseKeys(cInput, device, this.log)
      const type =
        keys.length === 1 && /^KEY_HDMI[0-4]?$/.test(keys[0])
          ? this.Characteristic.InputSourceType.HDMI
          : this.Characteristic.InputSourceType.OTHER
      sources.push({
        label: cInput.name,
        type,
        fn: async (config: DeviceConfig) => {
          await remote.sendKeys(config, keys as KEYS[])
        },
      })
    }

    // Set current input source to 0 = tv
    tvService.updateCharacteristic(this.Characteristic.ActiveIdentifier, 0)
    // handle input source changes
    let resetActiveIdentifierTimer: NodeJS.Timeout
    tvService
      .getCharacteristic(this.Characteristic.ActiveIdentifier)
      .on(`set`, async (newValue, callback) => {
        // Clear old timeout if not cleared already
        clearTimeout(resetActiveIdentifierTimer)

        // the value will be the value you set for the Identifier Characteristic
        // on the Input Source service that was selected - see input sources below.
        const inputSource = sources[newValue as any]
        this.log.debug(
          `${tvName} - SET Active Identifier => setNewValue: ${newValue} (${inputSource.label})`,
        )
        try {
          if (typeof inputSource.fn === `function`) {
            await inputSource.fn(this.getDevice(usn))
          }
          tvService.updateCharacteristic(
            this.Characteristic.ActiveIdentifier,
            newValue,
          )
        } catch (err) {
          callback(err)
          return
        }
        // Switch back to "TV" input source after 3 seconds
        resetActiveIdentifierTimer = setTimeout(() => {
          tvService.updateCharacteristic(
            this.Characteristic.ActiveIdentifier,
            0,
          )
        }, 3000)
        callback(null)
      })

    for (let i = 0; i < sources.length; ++i) {
      const { label, type } = sources[i]
      const inputService = tvAccessory.addService(
        this.Service.InputSource,
        /* `input-${i}` */ label,
        label,
      )
      inputService
        .setCharacteristic(this.Characteristic.Identifier, i)
        .setCharacteristic(this.Characteristic.ConfiguredName, label)
        .setCharacteristic(
          this.Characteristic.IsConfigured,
          this.Characteristic.IsConfigured.CONFIGURED,
        )
        .setCharacteristic(
          this.Characteristic.CurrentVisibilityState,
          this.Characteristic.CurrentVisibilityState.SHOWN,
        )
        .setCharacteristic(this.Characteristic.InputSourceType, type)
      tvService.addLinkedService(inputService)
    }

    /**
     * Publish as external accessory
     * Only one TV can exist per bridge, to bypass this limitation, you should
     * publish your TV as an external accessory.
     */
    this.api.publishExternalAccessories(PLUGIN_NAME, [tvAccessory])
  }
}
