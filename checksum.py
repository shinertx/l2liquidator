import re
from eth_hash.auto import keccak

def to_checksum_address(address: str) -> str:
    if not isinstance(address, str):
        raise TypeError("Address must be a string.")

    if address.startswith('0x'):
        address = address[2:]
    
    print(f'Address: {address}, Length: {len(address)}')

    if not re.fullmatch(r'[0-9a-fA-F]{40}', address):
        raise ValueError("Invalid Ethereum address format. Must be 40 hexadecimal characters.")

    address_lower = address.lower()

    address_hash = keccak(address_lower.encode('ascii')).hex()

    checksummed_address = "0x"
    for i, char in enumerate(address_lower):
        if int(address_hash[i], 16) >= 8:
            checksummed_address += char.upper()
        else:
            checksummed_address += char
            
    return checksummed_address

if __name__ == "__main__":
    addresses = [
        "0x37D9dC70C33029967d616b805474f560E891D1",
        "0x696fb0d70d4e64aF8014705F00039255c55cb9aa",
        "0x47Fb2585D2C56Fe188D0E6ec628a38B74fCeeeDf"
    ]
    for address in addresses:
        try:
            checksum_address = to_checksum_address(address)
            print(f'{address},{checksum_address}')
        except ValueError as e:
            print(f"Error: {e}")
        except TypeError as e:
            print(f"Error: {e}")
