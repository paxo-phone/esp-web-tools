import { FileBrowser } from "../util/file-browser";
import { sleep } from "../util/sleep";
import { Logger } from "../const";
import { findSubarrayIndex } from "../util/find-subarray-index";
import { Uint8LineBreakTransformer } from "../util/line-break-transformer";

export class EwtCFileBrowser extends HTMLElement {
  public port!: SerialPort;
  public logger!: Logger;
  public allowInput = true;

  private _path = "";

  private _fileBrowser?: FileBrowser;

  private __consoleBuffer = new Uint8Array();

  private get _consoleBuffer(): Uint8Array {
    return this.__consoleBuffer;
  }

  private set _consoleBuffer(newBuffer: Uint8Array) {
    // detect if new full packets have been added to the buffer

    const { packets, rest } = this._getPackets(newBuffer);

    for (const packet of packets) {
      const commandId = packet.commandId;
      const packetContent = packet.packetContent;

      this._receivedPackets.set(commandId, packetContent);
    }

    this.__consoleBuffer = rest;
  }

  private _receivedPackets = new Map<string, Uint8Array>();

  private _getPackets(buffer: Uint8Array): {
    packets: Array<{ commandId: string; packetContent: Uint8Array }>;
    rest: Uint8Array;
  } {
    let packets: { commandId: string; packetContent: Uint8Array }[] = [];

    var rest = buffer;

    while (true) {
      const beginIndex = findSubarrayIndex(
        rest,
        new Uint8Array([0xff, 0xfe, 0xfd]),
      );
      if (beginIndex === undefined) {
        break;
      }

      let packet = rest.slice(beginIndex + 3);
      if (packet.length < 16) {
        // Not enough data yet, waiting for more, expecting at least 16 bytes
        break;
      }

      let cursor = 0;
      const commandId = new TextDecoder().decode(
        packet.slice(cursor, cursor + 8),
      );
      cursor += 8;
      const length = packet[cursor++] + (packet[cursor++] << 8);
      const options = packet[cursor++] + (packet[cursor++] << 8);
      const pseudoHash =
        packet[cursor++] +
        (packet[cursor++] << 8) +
        (packet[cursor++] << 16) +
        (packet[cursor++] << 24);

      packet = packet.slice(cursor);

      if (packet.length < length) {
        // Not enough data yet, waiting for more, expecting at least "length" bytes
        break;
      }

      rest = packet.slice(length);
      packet = packet.slice(0, length);

      if (this.debug) {
        console.log(
          "Found packet with command ID: ",
          commandId,
          Array.from(new TextEncoder().encode(commandId))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
          ", length: ",
          length,
          ", options: ",
          options,
          ", pseudoHash: ",
          pseudoHash,
          packet,
        );
      }

      let calculatedHash = 0;
      for (let i = 0; i < length; i++) {
        calculatedHash = (calculatedHash + packet[i]) % 4294967295;
      }
      if (calculatedHash !== pseudoHash) {
        console.log("Hashes do not match, data corrupted");
        continue;
      }

      packets.push({ commandId: commandId, packetContent: packet });
    }

    return { packets: packets, rest: rest };
  }

  private _cancelConnection?: () => Promise<void>;

  private debug = true;

  public connectedCallback() {
    const shadowRoot = this.attachShadow({ mode: "open" });

    shadowRoot.innerHTML = `
      <style>
        :host, input {
          background-color: #1c1c1c;
          color: #ddd;
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier,
            monospace;
          line-height: 1.45;
          display: flex;
          flex-direction: column;
        }
        form {
          display: flex;
          align-items: center;
          padding: 0 8px 0 16px;
        }
        input {
          flex: 1;
          padding: 4px;
          margin: 0 8px;
          border: 0;
          outline: none;
        }
      </style>
      <button id="addDirectory">+</button>
      <div class="file-browser" ></div>
    `;

    this._fileBrowser = new FileBrowser(
      this.shadowRoot!.querySelector(".file-browser")!,
      this._downloadFile.bind(this),
      this._deleteFile.bind(this),
      this._goToDirectory.bind(this),
    );

    this.shadowRoot!.querySelector("#addDirectory")!.addEventListener(
      "click",
      () => {
        let newDirectoryName = prompt("Enter the name of the new directory.");
        if (newDirectoryName) {
          this._createDirectory(this._path + "/" + newDirectoryName);
        }
      },
    );

    this._fileBrowser!.targetElement.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.stopPropagation();
      //this._fileBrowser!.targetElement.appendChild(document.createTextNode("File(s) dropped"));
    });

    this._fileBrowser!.targetElement.addEventListener("dragleave", (event) => {
      event.preventDefault();
      event.stopPropagation();
      //this._fileBrowser!.targetElement.removeChild(this._fileBrowser!.targetElement.lastChild!);
    });
    this._fileBrowser!.targetElement.addEventListener(
      "drop",
      (event) => {
        event.preventDefault();
        //event.stopPropagation();

        const items = event.dataTransfer!.items;
        let files: Array<FileSystemFileEntry> = [];
        let directories: Array<FileSystemDirectoryEntry> = [];

        const supportsWebkitGetAsEntry =
          "webkitGetAsEntry" in DataTransferItem.prototype;
        if (supportsWebkitGetAsEntry) {
          for (let i = 0; i < items.length; i++) {
            let directory = items[
              i
            ].webkitGetAsEntry() as FileSystemDirectoryEntry;
            if (directory.isDirectory) {
              directories.push(directory);
            } else if (directory.isFile) {
              let file = items[i].webkitGetAsEntry() as FileSystemFileEntry;

              if (file) {
                files.push(file);
              }
            }
          }
        }

        (async () => {
          for (let i = 0; i < files.length; i++) {
            const fileEntry = files[i];
            console.log("Uploading file: " + fileEntry.name);

            const file = await new Promise<File>((resolve, _) => {
              fileEntry.file((file) => {
                resolve(file);
              });
            });

            await this._uploadFile(file);
          }

          for (let i = 0; i < directories.length; i++) {
            const directory = directories[i];
            console.log("Uploading directory: " + directory.name);
            await this._uploadDirectory(directory);
          }
        })();
      },
      false,
    );
    //this._fileBrowser!.targetElement.addEventListener("change", FileSelectHandler, false);

    const abortController = new AbortController();
    const connection = this._connect(abortController.signal);
    this._cancelConnection = () => {
      abortController.abort();
      return connection;
    };
    const target = async () => {
      const com1 = await this._sendCommand("sm disable");
      await this._getCommandResult(com1);
      const com2 = await this._sendCommand("console lock");
      console.log("console lock", await this._getCommandResult(com2));
      await this._fetchFilesAndDirectories();
    };
    target();
  }
  private async _connect(abortSignal: AbortSignal) {
    this.logger.debug("Starting console read loop");
    this.logger.debug("Fetching files");

    try {
      let controller = new TransformStream(new Uint8LineBreakTransformer());
      controller.writable
        .getWriter()
        .write()
        .then(() => {
          controller.readable
            .getReader()
            .read()
            .then(({ value, done }) => {
              if (done) {
                console.log("Stream closed");
                return;
              }
              console.log("Received chunk: " + value);
            });
        });
      const reader = this.port.readable!.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          if (this.debug) {
            console.log("Received raw bytes:", value);
            console.log("Raw bytes text: " + new TextDecoder().decode(value));
          }
          if (
            this._consoleBuffer[this._consoleBuffer.length - 1] === 13 &&
            value[0] === 10
          ) {
            let dynamicArray = Array.from(
              this._consoleBuffer!.subarray(0, this._consoleBuffer.length - 1),
            ).concat(Array.from(value));
            this._consoleBuffer = new Uint8Array(dynamicArray);
          } else {
            let dynamicArray = Array.from(this._consoleBuffer!).concat(
              Array.from(value),
            );
            this._consoleBuffer = new Uint8Array(dynamicArray);
          }
        }
      }
      if (!abortSignal.aborted) {
        console.log("Terminal disconnected");
      }
    } catch (e) {
      console.log(`Terminal disconnected: ${e}`);
    } finally {
      await sleep(100);
      this.logger.debug("Finished console read loop");
    }
  }

  private async _fetchFilesAndDirectories() {
    const result = await this._fetchFilesAndDirectoriesForPath(this._path);

    if (result === undefined) {
      return;
    }

    this._fileBrowser!.setFilesAndDirectories(
      result.files,
      result.directories,
      this._path,
    );
  }

  private async _fetchFilesAndDirectoriesForPath(
    path: string,
    retryCount: number = 0,
  ): Promise<{ files: string[]; directories: string[] } | undefined> {
    this._consoleBuffer = new Uint8Array();
    const commandId = await this._sendCommand(
      path == "" ? "ls" : "ls " + '"' + path + '"',
    );
    const encodedResult = await this._getCommandResult(commandId);
    if (
      encodedResult === undefined ||
      (encodedResult[0] == 75 && encodedResult[1] == 79)
    ) {
      // KO
      if (retryCount < 3) {
        console.log("Failed to fetch files, retrying...");
        return this._fetchFilesAndDirectoriesForPath(path, retryCount + 1);
      }
      console.log("Failed to fetch files after 3 retries, giving up.");
      return undefined;
    }
    const result = new TextDecoder().decode(encodedResult);
    const json = JSON.parse(result);

    const files = json.files;
    const directories = json.directories;

    return { files, directories };
  }

  private async _goToDirectory(directory: string) {
    this._path = directory;
    await this._fetchFilesAndDirectories();
  }

  private async _createDirectory(path: string) {
    const commandId = await this._sendCommand('mkdir "' + path + '"');
    const result = await this._getCommandResult(commandId);
    if (result === undefined || (result[0] == 75 && result[1] == 79)) {
      // KO
      console.log("Failed to create directory");
      return undefined;
    } else {
      await this._fetchFilesAndDirectories();
    }
  }

  private async _deleteFile(filePath: string) {
    const commandId = await this._sendCommand('rm "' + filePath + '"');
    const result = await this._getCommandResult(commandId);
    if (result === undefined || (result[0] == 75 && result[1] == 79)) {
      // KO
      console.log("Failed to delete file");
      return undefined;
    } else {
      await this._fetchFilesAndDirectories();
    }
  }

  private async _downloadFile(filePath: string) {
    console.log("Downloading file: " + filePath);

    this._consoleBuffer = new Uint8Array();
    let commandId = Math.random().toString(36).substring(2, 9);
    let encodedCommandId = new TextEncoder().encode(commandId);
    encodedCommandId = new Uint8Array([...encodedCommandId, 0x00]); // pad with zeros to 8 bytes
    commandId = new TextDecoder().decode(encodedCommandId);
    await this._sendCommand('download "' + filePath + '"', commandId);
    let baseResult = await this._getCommandResult(commandId);
    if (baseResult === undefined) {
      console.log("Failed to download file");
      return undefined;
    }

    if (baseResult[0] != 79 || baseResult[1] != 75) {
      // OK
      console.log("Failed to download file");
      return undefined;
    }

    const fileSize =
      baseResult[2] +
      (baseResult[3] << 8) +
      (baseResult[4] << 16) +
      (baseResult[5] << 24);

    let recoveredData = new Uint8Array();

    let count = 1;

    while (recoveredData.length < fileSize) {
      let newCommandId = encodedCommandId.slice(0, 6);
      let count16Byte = new Uint8Array(2);
      count16Byte[0] = (count >> 8) & 0xff;
      count16Byte[1] = count & 0xff;
      newCommandId = new Uint8Array([...newCommandId, ...count16Byte]); // pad with zeros to 8 bytes
      count++;
      console.log(
        "expecting packet with command ID: ",
        Array.from(newCommandId)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      );
      const dataResult = await this._getCommandResult(
        new TextDecoder().decode(newCommandId),
      );
      if (dataResult === undefined) {
        console.log("Failed to download file");
        return undefined;
      }
      recoveredData = new Uint8Array([...recoveredData, ...dataResult]);
    }

    const blob = new Blob([recoveredData], {
      type: "application/octet-stream",
    });
    const data = URL.createObjectURL(blob);
    // download in the browser automatically
    const link = document.createElement("a");
    link.href = data;
    link.download = filePath.split("/").pop()!;

    // this is necessary as link.click() does not work on the latest firefox
    link.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );

    setTimeout(() => {
      // For Firefox it is necessary to delay revoking the ObjectURL
      window.URL.revokeObjectURL(data);
      link.remove();
    }, 100);
  }

  private async _uploadDirectory(
    directory: FileSystemDirectoryEntry,
    path: string = this._path,
  ) {
    // check if the directory exists in the paxo

    let currentDirItemsList = await this._fetchFilesAndDirectoriesForPath(path);

    if (currentDirItemsList === undefined) {
      console.log("Failed to upload directory");
      return;
    }

    if (currentDirItemsList.files.includes(directory.name)) {
      console.log("File with the same name already exists, skipping...");
      return;
    }

    if (!currentDirItemsList.directories.includes(directory.name)) {
      await this._createDirectory(path + "/" + directory.name);
    }

    // upload files in it

    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      directory.createReader().readEntries((entries) => {
        resolve(entries);
      });
    });

    this._path = path + "/" + directory.name;
    await this._fetchFilesAndDirectories();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.isFile) {
        const fileEntry = entry as FileSystemFileEntry;

        // convert to File

        const file = await new Promise<File>((resolve, _) => {
          fileEntry.file((file) => {
            resolve(file);
          });
        });

        await this._uploadFile(file, path + "/" + directory.name);
      } else if (entry.isDirectory) {
        const dir = entry as FileSystemDirectoryEntry;
        await this._uploadDirectory(dir, path + "/" + directory.name);
      }
    }
  }

  private async _uploadFile(
    file: File,
    path: string = this._path,
    retry: number = 0,
  ) {
    const data = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsArrayBuffer(file);

      reader.onloadend = () => {
        if (reader.error) {
          reject(reader.error);
        } else {
          resolve(new Uint8Array(reader.result as ArrayBuffer));
        }
      };
    });
    const fileSize = data.length;

    let chunksToSend: Array<Uint8Array> = [];

    let offset = 0;
    let packetCount = 0;
    while (offset < fileSize) {
      console.log("creating chunk");
      const chunkSize = Math.min(1024, fileSize - offset);

      let dataToSend = data.slice(offset, offset + chunkSize);

      let checksum = 0;

      for (let i = 0; i < dataToSend.length; i++) {
        checksum = (checksum + dataToSend[i]) % 4294967295;
      }

      const bufferSizeArray = new Uint8Array([
        chunkSize & 0xff,
        (chunkSize >> 8) & 0xff,
      ]);

      //const commandId = Math.random().toString(36).substring(2, 10);
      //const encodedCommandId = new TextEncoder().encode(commandId);

      const optionsArray = new Uint8Array([0x00, 0x00]);

      const checksumBytes = new Uint8Array([
        checksum & 0xff,
        (checksum >> 8) & 0xff,
        (checksum >> 16) & 0xff,
        (checksum >> 24) & 0xff,
      ]);

      const packetIndexBytes = new Uint8Array([
        packetCount & 0xff,
        (packetCount >> 8) & 0xff,
      ]);

      chunksToSend.push(
        new Uint8Array([
          ...bufferSizeArray,
          ...optionsArray,
          ...checksumBytes,
          ...packetIndexBytes,
          ...dataToSend,
        ]),
      );

      offset += chunkSize;
    }

    console.log("Chunks prepared for upload");

    this._consoleBuffer = new Uint8Array();
    const commandId = await this._sendCommand(
      'upload "' + path + "/" + file.name + '" ' + fileSize,
    );
    console.log("Command ID: %s", commandId);
    let baseResult = await this._getCommandResult(commandId);
    if (
      baseResult === undefined ||
      (baseResult[0] == 75 && baseResult[1] == 79)
    ) {
      // KO
      if (retry < 3) {
        console.log("Failed to upload file, retrying...");
        this._uploadFile(file, path, retry + 1);
        return;
      }
      console.log("Failed to upload file after 3 retries, giving up.");
      return;
    }

    console.log("Upload confirmed");

    for (let i = 0; i < chunksToSend.length; i++) {
      const dataToSend = chunksToSend[i];

      await this._sendRawCommand(dataToSend, commandId);
      console.log("Sent chunk " + (i + 1) + " of " + chunksToSend.length);
      let chunkSendResult = await this._getCommandResult(commandId);
      if (chunkSendResult === undefined) {
        console.log("Failed to upload file");
        return;
      } else if (
        Number(chunkSendResult[0]) == 82 &&
        Number(chunkSendResult[1]) == 69
      ) {
        // RE -> send the chunk again
        i--;
        console.log("Failed to upload chunk, retrying...");
        continue;
      } else if (chunkSendResult[0] != 79 || chunkSendResult[1] != 75) {
        // OK
        console.log("Failed to upload file");
        return;
      }

      console.log("Chunk sent successfully");
    }

    const operationResult = await this._getCommandResult(commandId);
    if (
      operationResult == undefined ||
      (operationResult[0] == 75 && operationResult[1] == 79)
    ) {
      if (retry < 3) {
        await this._deleteFile(path + "/" + file.name);
        console.log("Failed to upload file, retrying...");
        await this._uploadFile(file, path, retry + 1);
        return;
      }
      console.log("Failed to upload file after 3 retries, giving up.");
      return;
    }

    await this._fetchFilesAndDirectories();
  }

  private async _sendCommand(
    command: string,
    commandId: string | undefined = undefined,
  ): Promise<string> {
    const encoder = new TextEncoder();
    console.log("Sending command: ", command);
    return await this._sendRawCommand(
      encoder.encode(command + "\n"),
      commandId,
    );
  }

  private async _sendRawCommand(
    command: Uint8Array,
    commandId: string | undefined = undefined,
    includeCommandId: boolean = true,
  ): Promise<string> {
    if (commandId === undefined) {
      commandId = Math.random().toString(36).substring(2, 10);
    }

    // convert to UInt8Array
    let encodedCommandId = new TextEncoder().encode(commandId.substring(0, 8));
    encodedCommandId = new Uint8Array([
      ...encodedCommandId,
      ...new Uint8Array(8 - encodedCommandId.length),
    ]); // pad with zeros to 8 bytes

    if (this.debug) {
      console.log(
        "trying to aquire lock for command",
        commandId,
        "with command",
        command,
      );
      console.trace();
    }
    const writer = this.port.writable!.getWriter();
    if (this.debug) {
      if (includeCommandId) {
        console.log(
          "Sending command: ",
          commandId,
          new Uint8Array([0xff, 0xfe, 0xfd, ...encodedCommandId, ...command]),
        );
      } else {
        console.log(
          "Sending command without ID: ",
          new Uint8Array([0xff, 0xfe, 0xfd, ...command]),
        );
      }
    }
    if (includeCommandId) {
      await writer.write(
        new Uint8Array([0xff, 0xfe, 0xfd, ...encodedCommandId, ...command]),
      );
    } else {
      await writer.write(new Uint8Array([0xff, 0xfe, 0xfd, ...command]));
    }
    await sleep(20);
    try {
      writer.releaseLock();
      if (this.debug) {
        console.log("Lock for command", commandId, "released successfully");
      }
    } catch (err) {
      console.error("Ignoring release lock error", err);
    }
    if (this.debug) {
      console.log("Command", commandId, "sent successfully", command);
    }
    return commandId;
  }

  // _fetchCommandResult that fetches new data from the serial port and returns it
  private async _getCommandResult(
    commandId: string,
  ): Promise<Uint8Array | undefined> {
    this.logger.debug("Waiting for command result for command ID: ", commandId);
    const timeout = 5000; // 5 seconds timeout
    const startTime = Date.now();

    while (true) {
      if (this._receivedPackets.has(commandId)) {
        const packetContent = this._receivedPackets.get(commandId)!;
        this._receivedPackets.delete(commandId);
        this.logger.debug(
          "Received command result for command ID: ",
          commandId,
        );
        return packetContent;
      }

      if (Date.now() - startTime > timeout) {
        console.log(
          "Timeout waiting for command result for command ID: ",
          commandId,
        );
        return undefined;
      }

      await sleep(10); // wait before checking again
    }
  }

  public async disconnect() {
    if (this._cancelConnection) {
      await this._cancelConnection();
      this._cancelConnection = undefined;
    }
  }

  public async reset() {
    this.logger.debug("Triggering reset");
    await this.port.setSignals({
      dataTerminalReady: false,
      requestToSend: true,
    });
    await sleep(250);
    await this.port.setSignals({
      dataTerminalReady: false,
      requestToSend: false,
    });
    await sleep(250);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

customElements.define("ewt-file-browser", EwtCFileBrowser);

declare global {
  interface HTMLElementTagNameMap {
    "ewt-file-browser": EwtCFileBrowser;
  }
}
