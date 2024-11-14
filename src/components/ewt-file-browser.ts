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
  private _files: string[] = [];
  private _directories: string[] = [];

  private _fileBrowser?: FileBrowser;

  private _consoleBuffer = new Uint8Array();
  private _cancelConnection?: () => Promise<void>;

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

    this._fileBrowser = new FileBrowser(this.shadowRoot!.querySelector(".file-browser")!, this._downloadFile.bind(this), this._deleteFile.bind(this), this._goToDirectory.bind(this));

    this.shadowRoot!.querySelector("#addDirectory")!.addEventListener("click", () => {
      let newDirectoryName = prompt("Enter the name of the new directory.");
      if (newDirectoryName) {
        this._createDirectory(newDirectoryName);
      }
    });

    this._fileBrowser!.targetElement.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.stopPropagation();
      //this._fileBrowser!.targetElement.appendChild(document.createTextNode("File(s) dropped"));
    });
    
    this._fileBrowser!.targetElement.addEventListener('dragleave', (event) => {
      event.preventDefault();
      event.stopPropagation();
      //this._fileBrowser!.targetElement.removeChild(this._fileBrowser!.targetElement.lastChild!);
    });
    this._fileBrowser!.targetElement.addEventListener("drop", (event) => {
      event.preventDefault();
      //event.stopPropagation();


      const items = event.dataTransfer!.items;
      let files: Array<FileSystemFileEntry> = [];
      let directories: Array<FileSystemDirectoryEntry> = [];

      const supportsWebkitGetAsEntry = 'webkitGetAsEntry' in DataTransferItem.prototype;
      if (supportsWebkitGetAsEntry) {
        for (let i = 0; i < items.length; i++) {
          let directory = items[i].webkitGetAsEntry() as FileSystemDirectoryEntry;
          if (directory) {
            directories.push(directory);
          } else {
            let file = items[i].webkitGetAsEntry() as FileSystemFileEntry;

            if (file) {
              files.push(file);
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
    }, false);
    //this._fileBrowser!.targetElement.addEventListener("change", FileSelectHandler, false);

    const abortController = new AbortController();
    const connection = this._connect(abortController.signal);
    this._cancelConnection = () => {
      abortController.abort();
      return connection;
    };
    const target = async () => {
        await this._sendCommand("sm disable");
        await this._getCommandResult();
        await this._sendCommand("console lock");
        await this._getCommandResult();
        await this._fetchFilesAndDirectories();
    };
    target();
  }

  private async _connect(abortSignal: AbortSignal) {
    this.logger.debug("Starting console read loop");
    this.logger.debug("Fetching files");

    try {
          let controller = new TransformStream(new Uint8LineBreakTransformer)
          controller.writable.getWriter().write().then(() => {
            controller.readable.getReader().read().then(({ value, done }) => {
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
              console.log("Received raw bytes:", value);
              //console.log("Raw bytes text: " + new TextDecoder().decode(value));
              if (this._consoleBuffer[this._consoleBuffer.length - 1] === 13 && value[0] === 10) {
                let dynamicArray = Array.from(this._consoleBuffer!.subarray(0, this._consoleBuffer.length - 1)).concat(Array.from(value));
                this._consoleBuffer = new Uint8Array(dynamicArray);
              } else {
                let dynamicArray = Array.from(this._consoleBuffer!).concat(Array.from(value));
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

    this._fileBrowser!.setFilesAndDirectories(result.files, result.directories, this._path);
  }

  private async _fetchFilesAndDirectoriesForPath(path: string): Promise<{ files: string[], directories: string[] } | undefined> {
    this._consoleBuffer = new Uint8Array();
    await this._sendCommand(path == "" ? "ls" : "ls " + '"' + path + '"');
    const result = new TextDecoder().decode(await this._getCommandResult());
    if (result === undefined) {
      console.log("Failed to fetch files");
      return undefined;
    }
    const json = JSON.parse(result);

    const files = json.files;
    const directories = json.directories;

    this._files = files;
    this._directories = directories;

    return { files, directories };
  }

  private async _goToDirectory(directory: string) {
    this._path = directory;
    await this._fetchFilesAndDirectories();
  }

  private async _createDirectory(directory: string) {
    let newPath = this._path + "/" + directory;

    await this._sendCommand("mkdir \"" + newPath + '"');
    const result = await this._getCommandResult();
    if (result === undefined || (result[0] == 75 && result[1] == 79)) { // KO
      console.log("Failed to create directory");
      return undefined;
    } else {
      await this._fetchFilesAndDirectories();
    }
  }

  private async _deleteFile(filePath: string) {
    await this._sendCommand("rm \"" + filePath + '"');
    const result = await this._getCommandResult();
    if (result === undefined || (result[0] == 75 && result[1] == 79)) { // KO
      console.log("Failed to delete file");
      return undefined;
    } else {
      await this._fetchFilesAndDirectories();
    }
  }

  private async _downloadFile(filePath: string) {
    console.log("Downloading file: " + filePath);

    this._consoleBuffer = new Uint8Array();
    await this._sendCommand("download \"" + filePath + '"');
    let baseResult = await this._getCommandResult();
    if (baseResult === undefined) {
      console.log("Failed to download file");
      return undefined;
    }

    if (baseResult[0] != 79 || baseResult[1] != 75) { // OK
      console.log("Failed to download file");
      return undefined;
    }

    const fileSize = baseResult[2] + (baseResult[3] << 8) + (baseResult[4] << 16) + (baseResult[5] << 24);

    let recoveredData = new Uint8Array();

    while (recoveredData.length < fileSize) {
      const dataResult = await this._getCommandResult();
      if (dataResult === undefined) {
        console.log("Failed to download file");
        return undefined;
      }
      recoveredData = new Uint8Array([...recoveredData, ...dataResult]);
    }

    const blob = new Blob([recoveredData], { type: "application/octet-stream" });
    const data = URL.createObjectURL(blob);
    // download in the browser automatically
    const link = document.createElement('a');
    link.href = data;
    link.download = filePath.split("/").pop()!;

    // this is necessary as link.click() does not work on the latest firefox
    link.dispatchEvent(
      new MouseEvent('click', { 
        bubbles: true, 
        cancelable: true, 
        view: window 
      })
    );

    setTimeout(() => {
      // For Firefox it is necessary to delay revoking the ObjectURL
      window.URL.revokeObjectURL(data);
      link.remove();
    }, 100);
  }

  private async _uploadDirectory(directory: FileSystemDirectoryEntry, path: string = this._path) {
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
      await this._createDirectory(directory.name);
    }

    // upload files in it

    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      directory.createReader().readEntries((entries) => {
        resolve(entries);
      });
    });

    this._path = path + "/" + directory.name;
    this._fetchFilesAndDirectories();

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

  private async _uploadFile(file: File, path: string = this._path) {
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

      let chunksToSend = [];

      let offset = 0;
      while (offset < fileSize) {
        console.log("creating chunk")
        const chunkSize = Math.min(256, fileSize - offset);

        let dataToSend = data.slice(offset, offset + chunkSize);

        let checksum = 0;

        for (let i = 0; i < dataToSend.length; i++) {
          checksum = (checksum + dataToSend[i]) % 4294967295;
        }

        const beginArray = new Uint8Array([0xff, 0xfe, 0xfd]); 

        const bufferSizeArray = new Uint8Array([chunkSize & 0xff, (chunkSize >> 8) & 0xff]);

        const optionsArray = new Uint8Array([0x00, 0x00]);

        const checksumBytes = new Uint8Array([
          checksum & 0xff,
          (checksum >> 8) & 0xff,
          (checksum >> 16) & 0xff,
          (checksum >> 24) & 0xff,
        ]);

        chunksToSend.push(new Uint8Array([...beginArray, ...bufferSizeArray, ...optionsArray, ...checksumBytes, ...dataToSend]));

        offset += chunkSize;
      }

      console.log("Chunks prepared for upload");

      this._consoleBuffer = new Uint8Array();
      await this._sendCommand("upload \"" + path + "/" + file.name + "\" " + fileSize);
      let baseResult = await this._getCommandResult();
      if (baseResult === undefined) {
        console.log("Failed to upload file");
        return undefined;
      }

      if (baseResult[0] != 79 || baseResult[1] != 75) { // OK
        console.log("Failed to upload file");
        return undefined;
      }

      console.log("Upload confirmed")

      for (let i = 0; i < chunksToSend.length; i++) {
        const dataToSend = chunksToSend[i];

        await this._sendRawCommand(dataToSend);
        console.log("Sent chunk " + i + " of " + chunksToSend.length);
        let chunkSendResult = await this._getCommandResult();
        if (chunkSendResult === undefined) {
          console.log("Failed to upload file");
          return undefined;
        } else if (Number(chunkSendResult[0]) == 82 && Number(chunkSendResult[1]) == 69) { // RE -> send the chunk again
          i--;
          console.log("Failed to upload chunk, retrying...");
          continue;
        } else if (chunkSendResult[0] != 79 || chunkSendResult[1] != 75) { // OK
          console.log("Failed to upload file");
          return undefined;
        }

        console.log("Chunk sent successfully");
      }

      const operationResult = await this._getCommandResult();
      if (operationResult == undefined || (operationResult[0] == 75 && operationResult[1] == 79)) {
        console.log("Failed to upload file (weird)...")
      }

      await this._fetchFilesAndDirectories();
  }

  private async _sendCommand(command: string) {
    const encoder = new TextEncoder();
    const writer = this.port.writable!.getWriter();
    console.log("Sending command: ", encoder.encode(command + "\n"));
    await writer.write(new Uint8Array([0xff, 0xfe, 0xfd, ...encoder.encode(command + "\n")]));
    //await writer.write(encoder.encode(command + "\n"));
    await sleep(50);
    try {
      writer.releaseLock();
    } catch (err) {
      console.error("Ignoring release lock error", err);
    }
 }

 private async _sendRawCommand(command: Uint8Array) {
    const writer = this.port.writable!.getWriter();
    console.log("Sending raw command: ", command);
    await writer .write(new Uint8Array([0xff, 0xfe, 0xfd, ...command]));
    //await writer.write(command);
    await sleep(50);
    try {
      writer.releaseLock();
    } catch (err) {
      console.error("Ignoring release lock error", err);
    }
  }

  // _fetchCommandResult that fetches new data from the serial port and returns it
  private async _getCommandResult(): Promise<Uint8Array | undefined> {
    let noMoreHeaderDataCount = 0;
    let noMoreDataCount = 0;
    while (true) {
      let data = this._consoleBuffer;

      const beginIndex = findSubarrayIndex(data, new Uint8Array([0xff, 0xfe, 0xfd]));

      if (beginIndex === undefined) {
        if (noMoreHeaderDataCount > 10) {
          console.log("No more data available, returning undefined");
          return undefined;
        }
        console.log("No command result found, waiting for more data");
        noMoreHeaderDataCount++;
        this._consoleBuffer = new Uint8Array();

        await sleep(100);
        continue;
      }

      data = data.slice(beginIndex + 4);

      console.log("Data is: ", data);

      if (data.length < 8) {
        if (noMoreHeaderDataCount > 10) {
          console.log("No more data available, returning undefined");
          return undefined;
        }
        console.log("Not enough data yet, waiting for more, expecting at least 8 bytes, got " + data.length + " bytes.");
        noMoreHeaderDataCount++;
        await sleep(100);
        continue;
      }

      noMoreHeaderDataCount = 0;

      const encodedData = data;
      const length = encodedData[0] + (encodedData[1] << 8);
      const options = encodedData[2] + (encodedData[3] << 8);
      const pseudoHash = encodedData[4] + (encodedData[5] << 8) + (encodedData[6] << 16) + (encodedData[7] << 24);

      // remove the header from the data
      if (encodedData.length < length + 8) {
        if (noMoreDataCount > 10) {
          console.log("No more data available, returning undefined");
          return undefined;
        }
        console.log("Not enough data yet, waiting for more, expecting " + (length + 8) + " bytes, got " + data.length + " bytes.");
        noMoreDataCount++;
        await sleep(100);
        continue;
      } 

      noMoreDataCount = 0;

      const dataWithoutHeader = encodedData.slice(8, length + 8);
      
      let calculatedHash = 0;

      for (let i = 0; i < length; i++) {
        calculatedHash = (calculatedHash + dataWithoutHeader[i]) % 4294967295;
      }

      this._consoleBuffer = encodedData.slice(length + 8);

      if (calculatedHash != pseudoHash) {
        console.log("Hashes do not match, data corrupted");
        return undefined;
      }

      return dataWithoutHeader;
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
