  export class FileBrowser {
    constructor(public targetElement: HTMLElement, private _downloadCallback: (path: string) => void, private _deleteCallback: (path: string) => void, private _goToDirectory: (path: string) => void) {}

    private _path = "";

    setFilesAndDirectories(files: string[], directories: string[], path: string) {
        this._path = path;

      this.targetElement.innerHTML = "";

        const pathElement = document.createElement("div");
        pathElement.classList.add("path");
        pathElement.textContent = "←" + path;
        pathElement.onclick = () => {
            const newPath = path.split("/").slice(0, -1).join("/");
            this._goToDirectory(newPath);
        }
        this.targetElement.appendChild(pathElement);


  
      for (const directory of directories) {
        this.targetElement.appendChild(this._createDirectoryElement(directory));
      }
  
      for (const file of files) {
        this.targetElement.appendChild(this._createFileElement(file));
      }
    }

    // creates a directory element with a name at the left and a right arrow icon at the right
    private _createDirectoryElement(directory: string) {
      const directoryElement = document.createElement("div");
      directoryElement.classList.add("directory");
      directoryElement.textContent = directory;

        const binIcon = document.createElement("span");
        binIcon.classList.add("icon");
        binIcon.textContent = "🗑";
        binIcon.onclick = () => {
            this._deleteCallback(this._getFilePath(directory));
        }
        directoryElement.appendChild(binIcon);

        const icon = document.createElement("span");
        icon.classList.add("icon");
        icon.textContent = "→";
        icon.onclick = () => {
            this._goToDirectory(this._getFilePath(directory));
            //this._goToDirectory(this._path.split("/").slice(0).filter((value) => value != "").join("/") + "/" + directory);
        }
        directoryElement.appendChild(icon);

      return directoryElement;
    }

    // creates a file element with a name at the left, a bin icon at the right, and a download icon at the right
    private _createFileElement(file: string) {
        const fileElement = document.createElement("div");
        fileElement.classList.add("file");
        fileElement.textContent = file;
    
            const binIcon = document.createElement("span");
            binIcon.classList.add("icon");
            binIcon.textContent = "🗑";
            binIcon.onclick = () => {
                this._deleteCallback(this._getFilePath(file));
            }
            fileElement.appendChild(binIcon);
    
            const downloadIcon = document.createElement("span");
            downloadIcon.classList.add("icon");
            downloadIcon.textContent = "⬇️";
            downloadIcon.onclick = () => {
                this._downloadCallback(this._getFilePath(file));
            }
            fileElement.appendChild(downloadIcon);
    
        return fileElement;
    }

    private _getFilePath(file: string) {
        return this._path[-1] == "/" ? this._path + file : this._path + "/" + file;
    }
  }