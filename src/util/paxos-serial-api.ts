import { ESPWebSerial } from "esp-web-tools";

/**
 * Classe qui sert de pont entre l'interface web et l'API série de PaxOS-9.
 * Elle encapsule la logique du protocole de communication.
 */
export class PaxosSerialAPI {
  // --- PLACEHOLDERS: À REMPLACER PAR LES VRAIES COMMANDES DE PAXOS-9 ---
  // Cherchez ces commandes dans le code C++ de PaxOS-9 (ex: dans un module de gestion série)
  private readonly CMD_LIST_FILES = "LIST_FILES";       // Commande pour lister les fichiers
  private readonly CMD_DELETE_FILE = "DELETE";          // Commande pour supprimer un fichier
  private readonly CMD_UPLOAD_START = "UPLOAD_START";   // Commande pour initier un upload

  private readonly RESPONSE_SUCCESS = "SUCCES";         // Mot-clé attendu pour un succès
  private readonly RESPONSE_ERROR = "ERREUR";           // Mot-clé attendu pour une erreur
  private readonly RESPONSE_READY = "OK_READY";         // Mot-clé attendu avant d'envoyer les données d'un fichier
  private readonly RESPONSE_LIST_DONE = "DONE";         // Mot-clé qui termine une liste de fichiers
  // --- FIN DES PLACEHOLDERS ---

  private esp: ESPWebSerial;

  constructor(esp: ESPWebSerial) {
    this.esp = esp;
  }

  /**
   * Envoie une commande pour lister les fichiers et dossiers d'un chemin donné.
   * @param path Le chemin à lister (ex: "/sd/")
   * @returns Un objet contenant les listes de fichiers et de dossiers.
   */
  public async listFiles(path: string): Promise<{ files: string[]; directories: string[] }> {
    const command = `${this.CMD_LIST_FILES} ${path}\n`;
    await this.esp.transport.write(new TextEncoder().encode(command));

    const files: string[] = [];
    const directories: string[] = [];

    while (true) {
      const line = await this.esp.serial.readUntil('\n');
      
      if (line.startsWith(this.RESPONSE_LIST_DONE)) break;
      if (line.startsWith(this.RESPONSE_ERROR)) {
        console.error("Erreur lors du listage:", line);
        throw new Error(line);
      }

      // Adaptez ce parsing au format de réponse réel de PaxOS-9
      const type = line.substring(0, 1);
      const name = line.substring(line.indexOf(':') + 1);

      if (type === 'D') directories.push(name);
      if (type === 'F') files.push(name);
    }
    return { files, directories };
  }

  /**
   * Envoie une commande pour supprimer un fichier ou un dossier.
   * @param path Le chemin complet de l'élément à supprimer.
   * @returns true si la suppression a réussi, false sinon.
   */
  public async deleteFile(path: string): Promise<boolean> {
    const command = `${this.CMD_DELETE_FILE} ${path}\n`;
    await this.esp.transport.write(new TextEncoder().encode(command));

    const response = await this.esp.serial.readUntil('\n');
    if (response.startsWith(this.RESPONSE_SUCCESS)) {
      return true;
    } else {
      console.error("Erreur de suppression:", response);
      return false;
    }
  }

  /**
   * Gère le processus complet d'upload d'un fichier vers l'appareil.
   * @param file L'objet Fichier provenant d'un <input type="file">.
   * @param destinationPath Le chemin complet de destination sur l'appareil (ex: "/sd/app.zip").
   * @param progressCallback Une fonction optionnelle pour suivre la progression (0 à 100).
   */
  public async uploadFile(
    file: File, 
    destinationPath: string, 
    progressCallback?: (progress: number) => void
  ): Promise<boolean> {
    // 1. Envoyer la commande d'initialisation
    const startCommand = `${this.CMD_UPLOAD_START} ${destinationPath} ${file.size}\n`;
    await this.esp.transport.write(new TextEncoder().encode(startCommand));

    // 2. Attendre que l'appareil soit prêt à recevoir les données
    const readyResponse = await this.esp.serial.readUntil('\n');
    if (!readyResponse.startsWith(this.RESPONSE_READY)) {
      console.error("L'appareil n'est pas prêt pour l'upload:", readyResponse);
      throw new Error("L'appareil a refusé l'upload : " + readyResponse);
    }

    // 3. Envoyer le contenu du fichier par morceaux pour la progression
    const fileData = await file.arrayBuffer();
    const chunkSize = 1024; // Envoyer par morceaux de 1KB
    let offset = 0;
    while (offset < fileData.byteLength) {
      const chunk = fileData.slice(offset, offset + chunkSize);
      await this.esp.transport.write(chunk);
      offset += chunk.length;
      if (progressCallback) {
        const progress = Math.round((offset / fileData.byteLength) * 100);
        progressCallback(progress);
      }
    }

    // 4. Attendre la confirmation finale
    const finalResponse = await this.esp.serial.readUntil('\n');
    if (finalResponse.startsWith(this.RESPONSE_SUCCESS)) {
      if (progressCallback) progressCallback(100);
      return true;
    } else {
      console.error("Erreur lors de la finalisation de l'upload:", finalResponse);
      return false;
    }
  }
}
